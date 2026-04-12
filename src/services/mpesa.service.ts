/**
 * FLOWFIT — M-Pesa Daraja Service
 *
 * BUGS FIXED IN THIS VERSION:
 *
 *   FIX-C3  CONSUMER_KEY / CONSUMER_SECRET declared at module level (unchanged from v2).
 *
 *   FIX-C4  In-memory _tokenCache instead of prisma.systemConfig (unchanged from v2).
 *
 *   FIX-S3  normalisePhone() no longer leaks PII in error messages (unchanged from v2).
 *
 *   FIX-4   initMpesaPayment used plan.yearlyPriceKes / plan.monthlyPriceKes which do
 *           NOT exist on the Plan model. Schema defines mpesaYearlyKes and
 *           mpesaMonthlyKes. Fixed to use the correct field names.
 *
 *   FIX-5   initMpesaPayment created an MpesaTransaction with no subscriptionId.
 *           The webhook handler checks `!mpesaTx.subscription` and exits early when
 *           it is null — meaning the payment was never activated. Fixed: a Subscription
 *           record (status INCOMPLETE) is now created first and its id is linked
 *           to the MpesaTransaction before the STK push is fired.
 *
 *   FIX-6   initMpesaPayment wrote `interval` into the MpesaTransaction create call,
 *           but MpesaTransaction had no interval field in the schema. Prisma threw
 *           "Unknown field `interval`" which aborted the entire create — this was the
 *           IMMEDIATE cause of the "Null constraint violation on planId" error (the
 *           insert never executed cleanly). The field is now in the schema (see
 *           schema.prisma FIX-2), so the write is correct and explicit.
 *
 *   FIX-7   initMpesaPayment returned void. The route handler did res.json(result)
 *           on the undefined return value, sending an empty response. Now returns
 *           a typed result object.
 */

import prisma from '../config/db.js';
import { MpesaTransactionStatus, BillingInterval } from '@prisma/client';

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

let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getOAuthToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (_tokenCache && _tokenCache.expiresAt > now + 60) {
    return _tokenCache.token;
  }

  const auth     = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await fetch(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } },
  );

  if (!response.ok) {
    throw new MpesaError(
      `Failed to obtain OAuth token (${response.status})`,
      String(response.status),
      null,
    );
  }

  const data = await response.json() as any;

  if (!data.access_token) {
    throw new MpesaError('Daraja returned no access_token', undefined, data);
  }

  _tokenCache = {
    token:     data.access_token,
    expiresAt: now + Number(data.expires_in ?? 3599),
  };

  return _tokenCache.token;
}

// ── STK Push ──────────────────────────────────────────────────────────────────

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage:   string;
}

export async function initiateStkPush(
  phone:       string,
  amount:      number,
  accountRef:  string,
  description: string,
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
    PartyA:            normalisePhone(phone),
    PartyB:            SHORTCODE,
    PhoneNumber:       normalisePhone(phone),
    CallBackURL:       CALLBACK_URL,
    AccountReference:  accountRef.slice(0, 12),
    TransactionDesc:   description.slice(0, 13),
  };

  const res = await fetch(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;

  if (!res.ok || data.errorCode) {
    throw new MpesaError(
      data.errorMessage ?? `STK Push failed (${res.status})`,
      data.errorCode,
      data,
    );
  }

  if (data.ResponseCode !== '0') {
    throw new MpesaError(
      data.ResponseDescription ?? 'STK Push rejected',
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

  const res = await fetch(`${DARAJA_BASE}/mpesa/stkpushquery/v1/query`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;

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
    receiptNumber:     get('MpesaReceiptNumber') !== null ? String(get('MpesaReceiptNumber')) : null,
    transactionDate:   get('TransactionDate')    !== null ? String(get('TransactionDate'))    : null,
    phoneNumber:       get('PhoneNumber')         !== null ? String(get('PhoneNumber'))        : null,
    amount:            get('Amount')              !== null ? Number(get('Amount'))             : null,
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
 * Create a Subscription (INCOMPLETE), link an MpesaTransaction, then fire
 * the STK Push. Returns identifiers the frontend needs to poll for status.
 *
 * FIX-5: A Subscription is now created before the MpesaTransaction so that
 *        the webhook handler can find `mpesaTx.subscription` and activate it.
 *
 * FIX-7: Returns a typed result instead of void so the route can respond
 *        with the checkoutRequestId and subscriptionId.
 */
export async function initMpesaPayment(
  planId:      string,
  phoneNumber: string,
  interval:    'MONTHLY' | 'YEARLY',
  userId:      string,
): Promise<InitMpesaPaymentResult> {

  // 1. Look up the plan
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error('Plan not found');

  // FIX-4: Use the correct schema field names (mpesaMonthlyKes / mpesaYearlyKes).
  //        The old code used monthlyPriceKes / yearlyPriceKes which do not exist
  //        on the Plan model, so amountKes was always undefined → NaN → Prisma
  //        wrote 0 or threw, depending on type coercion.
  const amountKes = interval === 'YEARLY' ? plan.mpesaYearlyKes : plan.mpesaMonthlyKes;

  if (!amountKes || amountKes <= 0) {
    throw new Error(`Plan "${plan.name}" has no M-Pesa price configured for ${interval} billing.`);
  }

  // 2. Fire the STK Push BEFORE creating DB records so we don't leave
  //    orphaned rows if Daraja is unavailable.
  const stkResponse = await initiateStkPush(
    phoneNumber,
    amountKes,
    `SUB-${plan.slug}`,
    `${plan.name} sub`,
  );

  // 3. Create Subscription (INCOMPLETE) + MpesaTransaction atomically.
  //    FIX-5: The subscription must exist before the transaction is created
  //           so the webhook callback can find it via mpesaTx.subscription.
  const { subscription, mpesaTx } = await prisma.$transaction(async (tx) => {
    // Create or upsert an INCOMPLETE subscription for this user+plan.
    // If the user already has an INCOMPLETE subscription for this plan,
    // reuse it (prevents duplicate rows from double-taps on the Pay button).
    let subscription = await tx.subscription.findFirst({
      where: {
        userId,
        planId,
        status: 'INCOMPLETE',
      },
    });

    if (!subscription) {
      const now      = new Date();
      const periodEnd = new Date(now);
      if (interval === 'YEARLY') {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      subscription = await tx.subscription.create({
        data: {
          userId,
          planId,
          status:   'INCOMPLETE',
          interval: interval as BillingInterval,
          provider: 'MPESA',
          currentPeriodStart: now,
          currentPeriodEnd:   periodEnd,
        },
      });
    }

    // FIX-6: interval is now a recognised field on MpesaTransaction (added to schema).
    const mpesaTx = await tx.mpesaTransaction.create({
      data: {
        subscriptionId:    subscription.id,   // FIX-5: always linked
        planId,                               // FIX-1a: nullable String? in schema
        userId,
        phoneNumber:       normalisePhone(phoneNumber),
        amountKes,
        status:            MpesaTransactionStatus.PENDING,
        checkoutRequestId: stkResponse.checkoutRequestId,
        merchantRequestId: stkResponse.merchantRequestId,
        interval:          interval as BillingInterval, // FIX-6
        isRenewal:         false,             // FIX-3: new sub, not a renewal
      },
    });

    return { subscription, mpesaTx };
  });

  // FIX-7: Return useful data for the route handler.
  return {
    checkoutRequestId: mpesaTx.checkoutRequestId,
    merchantRequestId: mpesaTx.merchantRequestId,
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
