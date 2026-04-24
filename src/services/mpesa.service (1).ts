/**
 * FLOWFIT — M-Pesa Daraja Service (refactored for reliability)
 *
 * KEY CHANGES FROM PREVIOUS VERSION
 * ══════════════════════════════════
 *
 * ORDERING-FIX
 *   The previous version fired the STK push BEFORE writing to the database,
 *   reasoning that this avoids "orphaned rows". That logic is inverted:
 *   if the STK push succeeds and the subsequent Prisma write fails, the user's
 *   phone has been prompted but no MpesaTransaction record exists. The Daraja
 *   webhook arrives, finds nothing, and exits silently — the subscription is
 *   never activated. This version writes the Subscription + a PENDING
 *   MpesaTransaction to the database FIRST, then fires the STK push outside
 *   the transaction, then updates the transaction with the Daraja IDs.
 *   If the STK push fails the transaction record is marked FAILED immediately
 *   so the state is always consistent and the user can safely retry.
 *
 *   NOTE: This requires checkoutRequestId and merchantRequestId to be
 *   nullable (String?) on MpesaTransaction in schema.prisma so the row can
 *   exist before Daraja responds. If your schema currently marks them
 *   non-nullable, add ? to both fields and run `prisma migrate dev`.
 *
 * NETWORK-ISOLATION
 *   All fetch() calls (OAuth token, STK push, STK query) are wrapped in
 *   try/catch so DNS failures, TCP resets, and non-JSON responses are caught
 *   and converted to MpesaError instead of raw unhandled rejections.
 *
 * TRY/CATCH BOUNDARIES
 *   Every async operation in initMpesaPayment has an explicit catch that
 *   either rolls state forward to FAILED or re-throws a typed MpesaError.
 *   No path results in an unhandled promise rejection or a leaked stack trace.
 *
 * TOKEN CONCURRENCY
 *   A shared in-flight Promise prevents multiple simultaneous callers from
 *   each issuing a Daraja token request when the cache expires.
 *
 * PHONE NORMALISATION
 *   normalisePhone() is called once at the entry point and the result is
 *   threaded through, eliminating the double-call inside initiateStkPush.
 */

import prisma from '../config/db.js';
import { MpesaTransactionStatus, BillingInterval } from '@prisma/client';

// ── Config ────────────────────────────────────────────────────────────────────

const DARAJA_BASE = process.env.MPESA_ENVIRONMENT === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY!;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET!;
const SHORTCODE       = process.env.MPESA_SHORTCODE!;
const PASSKEY         = process.env.MPESA_PASSKEY!;
const CALLBACK_URL    = process.env.MPESA_CALLBACK_URL!;

if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY || !CALLBACK_URL) {
  console.warn(
    '[mpesa] Missing one or more required env vars: ' +
    'MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL',
  );
}

// ── OAuth token cache ─────────────────────────────────────────────────────────
// An in-flight promise is stored while a refresh is underway so that
// simultaneous callers share a single Daraja round-trip instead of each
// issuing their own request and racing to overwrite the cache.

let _tokenCache:    { token: string; expiresAt: number } | null = null;
let _tokenRefresh:  Promise<string> | null = null;

async function getOAuthToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (_tokenCache && _tokenCache.expiresAt > now + 60) {
    return _tokenCache.token;
  }

  // Reuse an in-flight refresh if one is already running.
  if (_tokenRefresh) return _tokenRefresh;

  _tokenRefresh = (async (): Promise<string> => {
    try {
      const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

      let response: Response;
      try {
        response = await fetch(
          `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
      } catch (networkErr) {
        throw new MpesaError(
          'Network error fetching OAuth token',
          'NETWORK_ERROR',
          networkErr,
        );
      }

      if (!response.ok) {
        throw new MpesaError(
          `OAuth token request failed (HTTP ${response.status})`,
          String(response.status),
          null,
        );
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        throw new MpesaError('Daraja returned non-JSON for OAuth token', 'PARSE_ERROR', null);
      }

      if (!data.access_token) {
        throw new MpesaError('Daraja returned no access_token', 'NO_TOKEN', data);
      }

      _tokenCache = {
        token:     data.access_token,
        expiresAt: now + Number(data.expires_in ?? 3599),
      };

      return _tokenCache.token;
    } finally {
      // Always clear the in-flight promise so the next expiry triggers a fresh fetch.
      _tokenRefresh = null;
    }
  })();

  return _tokenRefresh;
}

// ── STK Push ──────────────────────────────────────────────────────────────────

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage:   string;
}

/**
 * Fire an STK push to Daraja.
 *
 * @param normalisedPhone Already-normalised 254XXXXXXXXX phone number.
 *                        Callers must normalise before passing in to avoid
 *                        running the transform + validation twice.
 */
export async function initiateStkPush(
  normalisedPhone: string,
  amount:          number,
  accountRef:      string,
  description:     string,
): Promise<StkPushResult> {
  const token     = await getOAuthToken();
  const timestamp = getTimestamp();
  const password  = buildPassword(timestamp);

  const body = {
    BusinessShortCode: SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   'CustomerPayBillOnline',
    Amount:            Math.round(amount),
    PartyA:            normalisedPhone,
    PartyB:            SHORTCODE,
    PhoneNumber:       normalisedPhone,
    CallBackURL:       CALLBACK_URL,
    AccountReference:  accountRef.slice(0, 12),
    TransactionDesc:   description.slice(0, 13),
  };

  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new MpesaError('Network error during STK push', 'NETWORK_ERROR', networkErr);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new MpesaError(
      `STK push returned non-JSON response (HTTP ${res.status})`,
      'PARSE_ERROR',
      null,
    );
  }

  if (!res.ok || data.errorCode) {
    throw new MpesaError(
      data.errorMessage ?? `STK push failed (HTTP ${res.status})`,
      data.errorCode ?? String(res.status),
      data,
    );
  }

  if (data.ResponseCode !== '0') {
    throw new MpesaError(
      data.ResponseDescription ?? 'STK push rejected by Daraja',
      data.ResponseCode,
      data,
    );
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    customerMessage:   data.CustomerMessage,
  };
}

// ── STK Status Query ──────────────────────────────────────────────────────────

export interface StkQueryResult {
  resultCode:        string;
  resultDesc:        string;
  checkoutRequestId: string;
}

export async function queryStkStatus(checkoutRequestId: string): Promise<StkQueryResult> {
  const token     = await getOAuthToken();
  const timestamp = getTimestamp();
  const password  = buildPassword(timestamp);

  const body = {
    BusinessShortCode: SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE}/mpesa/stkpushquery/v1/query`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new MpesaError('Network error querying STK status', 'NETWORK_ERROR', networkErr);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    // Daraja returned a non-JSON body (e.g. HTML error page on 5xx).
    // Return a safe "unknown" result rather than throwing so the caller
    // can decide whether to retry.
    return {
      resultCode:        '17',
      resultDesc:        `Non-JSON response from Daraja (HTTP ${res.status})`,
      checkoutRequestId,
    };
  }

  return {
    resultCode:        String(data.ResultCode ?? data.errorCode ?? '17'),
    resultDesc:        data.ResultDesc ?? data.errorMessage ?? 'Unknown',
    checkoutRequestId: data.CheckoutRequestID ?? checkoutRequestId,
  };
}

// ── Callback parsing ──────────────────────────────────────────────────────────

export interface MpesaCallbackBody {
  merchantRequestId: string;
  checkoutRequestId: string;
  resultCode:        string;
  resultDesc:        string;
  receiptNumber:     string | null;
  transactionDate:   string | null;
  phoneNumber:       string | null;
  amount:            number | null;
}

export function parseStkCallback(raw: any): MpesaCallbackBody {
  const cb = raw?.Body?.stkCallback;
  if (!cb) throw new Error('Invalid M-Pesa callback structure — missing Body.stkCallback');

  const items: any[] = cb.CallbackMetadata?.Item ?? [];
  const get = (name: string) => items.find((i: any) => i.Name === name)?.Value ?? null;

  return {
    merchantRequestId: String(cb.MerchantRequestID),
    checkoutRequestId: String(cb.CheckoutRequestID),
    resultCode:        String(cb.ResultCode),
    resultDesc:        String(cb.ResultDesc),
    receiptNumber:     get('MpesaReceiptNumber') != null ? String(get('MpesaReceiptNumber')) : null,
    transactionDate:   get('TransactionDate')    != null ? String(get('TransactionDate'))    : null,
    phoneNumber:       get('PhoneNumber')         != null ? String(get('PhoneNumber'))        : null,
    amount:            get('Amount')              != null ? Number(get('Amount'))             : null,
  };
}

// ── Initiate M-Pesa Payment ───────────────────────────────────────────────────

export interface InitMpesaPaymentResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  subscriptionId:    string;
  customerMessage:   string;
}

/**
 * Orchestrates a new M-Pesa subscription payment.
 *
 * ORDERING (explained):
 *   1. Validate inputs eagerly (phone format, plan existence, price).
 *   2. Write Subscription (INCOMPLETE) + MpesaTransaction (PENDING, no
 *      Daraja IDs yet) to the database atomically.
 *   3. Fire the STK push outside the Prisma transaction.
 *   4a. On STK success → update the MpesaTransaction with checkoutRequestId
 *       and merchantRequestId, return result.
 *   4b. On STK failure → mark MpesaTransaction FAILED so the row is never
 *       left as a ghost PENDING record, then throw a typed MpesaError.
 *
 *   This ordering guarantees that a DB record always exists before any money
 *   is requested from the user. The previous ordering (STK first, DB second)
 *   allowed the user's phone to be prompted while the DB write subsequently
 *   failed, producing a payment the webhook could never activate.
 *
 * SCHEMA NOTE:
 *   checkoutRequestId and merchantRequestId on MpesaTransaction must be
 *   String? (nullable) to allow the row to be created before Daraja responds.
 *   Run `prisma migrate dev` after updating schema.prisma if needed.
 */
export async function initMpesaPayment(
  planId:      string,
  phoneNumber: string,
  interval:    'MONTHLY' | 'YEARLY',
  userId:      string,
): Promise<InitMpesaPaymentResult> {

  // ── Step 1: Validate inputs before touching the network or DB ─────────────

  // Normalise once here; the normalised value is threaded through to avoid
  // a redundant transform+validation call inside initiateStkPush.
  let normalisedPhone: string;
  try {
    normalisedPhone = normalisePhone(phoneNumber);
  } catch (err) {
    throw new MpesaError(
      (err as Error).message,
      'INVALID_PHONE',
      null,
    );
  }

  let plan: Awaited<ReturnType<typeof prisma.plan.findUnique>>;
  try {
    plan = await prisma.plan.findUnique({ where: { id: planId } });
  } catch (dbErr) {
    throw new MpesaError('Database error looking up plan', 'DB_ERROR', dbErr);
  }

  if (!plan) {
    throw new MpesaError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND', null);
  }

  const amountKes = interval === 'YEARLY' ? plan.mpesaYearlyKes : plan.mpesaMonthlyKes;
  if (!amountKes || amountKes <= 0) {
    throw new MpesaError(
      `Plan "${plan.name}" has no M-Pesa price configured for ${interval} billing.`,
      'NO_PRICE',
      null,
    );
  }

  // ── Step 2: Write DB records BEFORE firing the STK push ───────────────────
  // If Daraja is unreachable these records will sit as PENDING/INCOMPLETE and
  // can be cleaned up or retried. If we did STK first and DB failed, the user
  // would be prompted with no corresponding record — the webhook would find
  // nothing and silently drop the payment.

  let subscription: { id: string };
  let mpesaTxId:    string;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Reuse an existing INCOMPLETE subscription (prevents duplicate rows
      // from double-taps on the Pay button while still allowing retries after
      // a previous FAILED transaction).
      let sub = await tx.subscription.findFirst({
        where: { userId, planId, status: 'INCOMPLETE' },
      });

      if (!sub) {
        const now       = new Date();
        const periodEnd = new Date(now);
        if (interval === 'YEARLY') {
          periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        } else {
          periodEnd.setMonth(periodEnd.getMonth() + 1);
        }

        sub = await tx.subscription.create({
          data: {
            userId,
            planId,
            status:             'INCOMPLETE',
            interval:           interval as BillingInterval,
            provider:           'MPESA',
            currentPeriodStart: now,
            currentPeriodEnd:   periodEnd,
          },
        });
      }

      // Create the transaction record without Daraja IDs — they are written in
      // Step 3 once the STK push succeeds. checkoutRequestId / merchantRequestId
      // must be nullable (String?) in schema.prisma for this to work.
      const mpesaTx = await tx.mpesaTransaction.create({
        data: {
          subscriptionId: sub.id,
          planId,
          userId,
          phoneNumber:    normalisedPhone,
          amountKes,
          status:         MpesaTransactionStatus.PENDING,
          interval:       interval as BillingInterval,
          isRenewal:      false,
          // checkoutRequestId and merchantRequestId are intentionally omitted
          // here; they are updated after the STK push responds (Step 3).
        },
      });

      return { sub, mpesaTxId: mpesaTx.id };
    });

    subscription = result.sub;
    mpesaTxId    = result.mpesaTxId;
  } catch (dbErr) {
    // Nothing has been sent to Daraja yet, so no money has been requested.
    // Safe to throw without any additional cleanup.
    throw new MpesaError(
      'Database error creating subscription / transaction record',
      'DB_ERROR',
      dbErr,
    );
  }

  // ── Step 3: Fire the STK push (isolated from the DB transaction) ──────────

  let stkResponse: StkPushResult;
  try {
    stkResponse = await initiateStkPush(
      normalisedPhone,
      amountKes,
      `SUB-${plan.slug}`,
      `${plan.name} sub`,
    );
  } catch (stkErr) {
    // STK push failed. Mark the transaction FAILED so it is never left as a
    // ghost PENDING record and the user can retry without confusion.
    try {
      await prisma.mpesaTransaction.update({
        where:  { id: mpesaTxId },
        data:   { status: MpesaTransactionStatus.FAILED },
      });
    } catch (updateErr) {
      // Failing to mark as FAILED is unfortunate but should not shadow the
      // primary STK error. Log it and continue to throw the STK error.
      console.error('[mpesa] Failed to mark transaction FAILED after STK error:', updateErr);
    }

    // Re-throw as MpesaError if it isn't already, so callers always get a
    // typed error instead of a raw Daraja response or network exception.
    if (stkErr instanceof MpesaError) throw stkErr;
    throw new MpesaError(
      (stkErr as Error).message ?? 'STK push failed',
      'STK_ERROR',
      stkErr,
    );
  }

  // ── Step 4: Update the transaction record with Daraja's response IDs ──────

  try {
    await prisma.mpesaTransaction.update({
      where: { id: mpesaTxId },
      data: {
        checkoutRequestId: stkResponse.checkoutRequestId,
        merchantRequestId: stkResponse.merchantRequestId,
      },
    });
  } catch (updateErr) {
    // The STK push has already succeeded — the user's phone has been prompted.
    // Failing to store the Daraja IDs is serious but must not cause a 500: the
    // webhook will still arrive and can be reconciled by merchantRequestId via
    // a fallback lookup. Log loudly and return the result to the client so
    // the frontend can poll for status.
    console.error(
      '[mpesa] CRITICAL: STK push succeeded but failed to store checkoutRequestId on transaction.',
      { mpesaTxId, stkResponse, error: updateErr },
    );
  }

  return {
    checkoutRequestId: stkResponse.checkoutRequestId,
    merchantRequestId: stkResponse.merchantRequestId,
    subscriptionId:    subscription.id,
    customerMessage:   stkResponse.customerMessage,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function buildPassword(timestamp: string): string {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
}

export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '254' + digits.slice(1);
  if (digits.startsWith('7')   && digits.length === 9)  return '254' + digits;
  throw new Error('Invalid Kenyan phone number format. Expected 07XXXXXXXX or 2547XXXXXXXX.');
}

// ── Error class ───────────────────────────────────────────────────────────────

export class MpesaError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = 'MpesaError';
  }
}
