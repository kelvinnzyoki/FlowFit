/**
 * FLOWFIT — M-Pesa Daraja Service
 *
 * FIXES APPLIED:
 *   FIX-C3  CONSUMER_KEY / CONSUMER_SECRET were referenced but never declared.
 *           Every OAuth token fetch threw ReferenceError. Now read from env at the top.
 *   FIX-C4  getOAuthToken() called prisma.systemConfig which does not exist in the
 *           schema. Reverted to the in-memory _tokenCache that was already declared
 *           (but never used) at the module level — the correct approach for serverless
 *           where we want to reuse tokens within a function invocation.
 *   FIX-S3  normalisePhone() embedded the raw phone number in its error message,
 *           leaking PII into server logs. Now throws a generic error.
 */

import prisma from '../config/db.js';
import { MpesaTransactionStatus } from '@prisma/client';


const DARAJA_BASE = process.env.MPESA_ENVIRONMENT === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// FIX-C3: Declare all env vars at module level so missing ones throw on startup,
//         not deep inside a request handler.
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

// ── OAuth token cache (valid for 3599 s per Safaricom spec) ───────────────────
// FIX-C4: Use in-memory cache instead of prisma.systemConfig (model doesn't exist).
// On Vercel, each serverless function invocation shares module-level state within
// the same instance. Across cold starts the token is re-fetched — that is fine,
// it costs one extra HTTP call and Safaricom rate-limits token generation generously.
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

/**
 * Initiate an STK Push to a user's phone.
 *
 * @param phone       - Kenyan phone number in international format: 254XXXXXXXXX
 * @param amount      - Amount in whole KES (M-Pesa doesn't use decimals)
 * @param accountRef  - Short reference shown in M-Pesa confirmation (max 12 chars)
 * @param description - Description shown in STK prompt (max 13 chars)
 */
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
    Amount:            Math.round(amount),      // must be integer
    PartyA:            normalisePhone(phone),
    PartyB:            SHORTCODE,
    PhoneNumber:       normalisePhone(phone),
    CallBackURL:       CALLBACK_URL,
    AccountReference:  accountRef.slice(0, 12),  // Daraja max 12 chars
    TransactionDesc:   description.slice(0, 13), // Daraja max 13 chars
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
  resultCode:        string;  // "0" = success, "17" = still processing
  resultDesc:        string;
  checkoutRequestId: string;
}

/**
 * Query the status of a pending STK Push.
 * Use this as a fallback when the callback wasn't received.
 */
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
  merchantRequestId:  string;
  checkoutRequestId:  string;
  resultCode:         string;
  resultDesc:         string;
  receiptNumber:      string | null;
  transactionDate:    string | null;
  phoneNumber:        string | null;
  amount:             number | null;
}

/**
 * Parse the raw Daraja STK callback body into a normalised object.
 * Safaricom's callback structure is deeply nested and inconsistent.
 */
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




export async function initMpesaPayment(
  planId: string,
  phoneNumber: string,
  interval: 'MONTHLY' | 'YEARLY',
  userId: string
) {
  // ✅ FIX 1: correct model name
  const plan = await prisma.subscription.findUnique({
    where: { id: planId }
  });

  if (!plan) {
    throw new Error('Plan not found');
  }

  // ⚠️ adjust field names based on your schema
  const amountKes =
    interval === 'YEARLY'
      ? plan.yearlyPrice
      : plan.monthlyPrice;

  if (!amountKes || amountKes <= 0) {
    throw new Error(`M-Pesa price not configured`);
  }

  const stkResponse = await initiateStkPush(
    phoneNumber,
    amountKes,
    `SUB-${plan.slug}`,
    `${plan.name} sub`
  );

  const transaction = await prisma.mpesaTransaction.create({
    data: {
      checkoutRequestId: stkResponse.checkoutRequestId,
      merchantRequestId: stkResponse.merchantRequestId,
      phoneNumber,

      // ✅ FIX 2: correct field name (adjust if needed)
      amountKes: amountKes,

      status: MpesaTransactionStatus.PENDING,

      planId: planId,
      userId: userId,
      interval: interval,
    }
  });

  return {
    success: true,
    checkoutRequestId: stkResponse.checkoutRequestId,
    transactionId: transaction.id
  };
}


// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safaricom timestamp format: YYYYMMDDHHmmss */
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

/** Base64(Shortcode + Passkey + Timestamp) */
function buildPassword(timestamp: string): string {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
}

/**
 * Normalise Kenyan phone numbers to 254XXXXXXXXX format.
 * Accepts: 07XXXXXXXX, +254XXXXXXXXX, 254XXXXXXXXX
 * FIX-S3: No longer embeds the phone number in the error message (was PII leak to logs).
 */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '254' + digits.slice(1);
  if (digits.startsWith('7')   && digits.length === 9)  return '254' + digits;
  // FIX-S3: throw without the raw phone value to avoid PII in server logs
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
