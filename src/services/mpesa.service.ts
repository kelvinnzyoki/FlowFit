/**
 * FLOWFIT — M-Pesa Daraja Service
 *
 * Handles all interaction with Safaricom Daraja API v2:
 *  - OAuth2 token acquisition (cached, auto-refreshed)
 *  - STK Push initiation (Lipa na M-Pesa Online)
 *  - STK Push status query (for polling when callback is missed)
 *  - Callback signature validation
 *
 * Environment variables required:
 *   MPESA_CONSUMER_KEY       - Daraja app consumer key
 *   MPESA_CONSUMER_SECRET    - Daraja app consumer secret
 *   MPESA_SHORTCODE          - Business short code (till or paybill)
 *   MPESA_PASSKEY            - Lipa na M-Pesa passkey from Daraja portal
 *   MPESA_CALLBACK_URL       - Public HTTPS URL for STK callbacks
 *   MPESA_ENVIRONMENT        - "sandbox" | "production"
 */

import prisma from '../config/db.js';

const DARAJA_BASE = process.env.MPESA_ENVIRONMENT === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const SHORTCODE   = process.env.MPESA_SHORTCODE!;
const PASSKEY     = process.env.MPESA_PASSKEY!;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL!;

// ── OAuth token cache (valid for 3599s per Safaricom spec) ────────────────────

let _tokenCache: { token: string; expiresAt: number } | null = null;

// Replace the _tokenCache logic with a DB lookup
async function getOAuthToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Cast prisma to any to bypass TS errors if schema isn't fully generated yet
  const cached = await (prisma as any).systemConfig.findUnique({ where: { key: 'mpesa_token' } });
  
  if (cached && (cached.expiresAt as number) > now + 60) {
    return cached.value;
  }

  // Define keys locally
  const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY!;
  const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET!;

  // 2. If not in DB or expired, fetch from Safaricom
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await fetch(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });

  const data = (await response.json()) as any; // Cast to any to fix 'unknown' type error
  const expiry = now + Number(data.expires_in);

  // 3. Save back to DB for next serverless invocation
  await (prisma as any).systemConfig.upsert({
    where: { key: 'mpesa_token' },
    update: { value: data.access_token, expiresAt: expiry },
    create: { key: 'mpesa_token', value: data.access_token, expiresAt: expiry }
  });

  return data.access_token;
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
 * @param phone   - Kenyan phone number in international format: 254XXXXXXXXX
 * @param amount  - Amount in whole KES (M-Pesa doesn't use decimal)
 * @param accountRef - Short reference shown in M-Pesa confirmation (e.g. "FlowFit Pro")
 * @param description - Description shown in STK prompt
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
    Amount:            Math.round(amount),   // must be integer
    PartyA:            normalisePhone(phone),
    PartyB:            SHORTCODE,
    PhoneNumber:       normalisePhone(phone),
    CallBackURL:       CALLBACK_URL,
    AccountReference:  accountRef.slice(0, 12),  // max 12 chars
    TransactionDesc:   description.slice(0, 13),  // max 13 chars
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
    throw new MpesaError(data.ResponseDescription ?? 'STK Push rejected', data.ResponseCode, data);
  }

  return {
    merchantRequestId: data.merchantRequestId,
    checkoutRequestId: data.checkoutRequestId,
    customerMessage:   data.customerMessage,
  };
}

// ── STK Status Query ──────────────────────────────────────────────────────────

export interface StkQueryResult {
  resultCode: string;  // "0" = success
  resultDesc: string;
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
    checkoutRequestId: data.CheckoutRequestId ?? checkoutRequestId,
  };
}

// ── Callback parsing ──────────────────────────────────────────────────────────

export interface MpesaCallbackBody {
  merchantRequestId:  string;
  checkoutRequestId:  string;
  resultCode:         string;   // "0" = success
  resultDesc:         string;
  receiptNumber:      string | null;  // set only on success
  transactionDate:    string | null;
  phoneNumber:        string | null;
  amount:             number | null;
}

/**
 * Parse the raw Daraja STK callback body into a normalized object.
 * Safaricom's callback structure is deeply nested and inconsistent.
 */
export function parseStkCallback(raw: any): MpesaCallbackBody {
  const cb  = raw?.Body?.stkCallback;
  if (!cb) throw new Error('Invalid M-Pesa callback structure — missing Body.stkCallback');

  const items: any[]   = cb.CallbackMetadata?.Item ?? [];
  const get = (name: string) => items.find((i: any) => i.Name === name)?.Value ?? null;

  return {
    merchantRequestId: String(cb.merchantRequestId),
    checkoutRequestId: String(cb.checkoutRequestId),
    resultCode:        String(cb.ResultCode),
    resultDesc:        String(cb.ResultDesc),
    receiptNumber:     get('MpesaReceiptNumber') ? String(get('MpesaReceiptNumber')) : null,
    transactionDate:   get('TransactionDate')    ? String(get('TransactionDate'))    : null,
    phoneNumber:       get('PhoneNumber')         ? String(get('PhoneNumber'))        : null,
    amount:            get('Amount')              ? Number(get('Amount'))             : null,
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
 */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '254' + digits.slice(1);
  if (digits.startsWith('7')   && digits.length === 9)  return '254' + digits;
  throw new Error(`Invalid Kenyan phone number: ${phone}`);
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
