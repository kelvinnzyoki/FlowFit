/**
 * FLOWFIT — M-Pesa (Safaricom Daraja) Service
 *
 * Supports sandbox and production. Set MPESA_ENV=production when going live.
 *
 * Required ENV vars (add to .env / Vercel environment settings):
 *   MPESA_CONSUMER_KEY      — from Safaricom Developer portal app
 *   MPESA_CONSUMER_SECRET   — from Safaricom Developer portal app
 *   MPESA_SHORTCODE         — Business shortcode (PayBill number)
 *   MPESA_PASSKEY           — Online passkey from portal
 *   MPESA_ENV               — 'sandbox' | 'production'   (default: sandbox)
 *   MPESA_EXCHANGE_RATE     — KES per 1 USD, e.g. 130   (default: 130)
 *   APP_URL                 — deployed app URL, used to build callback URL
 */

const BASE =
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// ─── OAuth token (1-hour expiry, cached) ──────────────────────────────────────
let _tokenCache: { value: string; expiresAt: number } | null = null;

export async function getMpesaToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) return _tokenCache.value;

  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error('MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET are not set');
  }

  const resp = await fetch(
    `${BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } },
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`M-Pesa OAuth failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: string };
  if (!data.access_token) throw new Error('M-Pesa OAuth returned no access_token');

  const ttlMs = (parseInt(data.expires_in ?? '3600', 10) - 60) * 1000;
  _tokenCache = { value: data.access_token, expiresAt: Date.now() + ttlMs };
  return _tokenCache.value;
}

// ─── Password & timestamp ─────────────────────────────────────────────────────
function makePassword(): { password: string; timestamp: string } {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey   = process.env.MPESA_PASSKEY;
  if (!shortcode || !passkey) throw new Error('MPESA_SHORTCODE and MPESA_PASSKEY are not set');

  const now       = new Date();
  const pad       = (n: number) => String(n).padStart(2, '0');
  const timestamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  return { password, timestamp };
}

// ─── Phone normalisation ──────────────────────────────────────────────────────
export function normalizePhone(raw: string): string {
  let phone = raw.replace(/[\s\-\(\)+]/g, '');
  if (phone.startsWith('07') || phone.startsWith('01')) phone = '254' + phone.slice(1);
  if (!/^254(7|1)\d{8}$/.test(phone)) {
    throw new Error(`Invalid Kenyan phone number: ${raw}`);
  }
  return phone;
}

// ─── KES amount from cents ────────────────────────────────────────────────────
export function centsToKes(priceCents: number): number {
  const rate = parseFloat(process.env.MPESA_EXCHANGE_RATE ?? '130');
  return Math.ceil((priceCents / 100) * rate);
}

// ─── STK Push ────────────────────────────────────────────────────────────────
export interface StkPushResult {
  MerchantRequestID:  string;
  CheckoutRequestID:  string;
  ResponseCode:       string;
  ResponseDescription: string;
  CustomerMessage:    string;
}

export async function initiateStkPush(
  phone:            string,   // Normalised 2547XXXXXXXX
  amountKes:        number,
  accountReference: string,
  description:      string,
  callbackUrl:      string,
): Promise<StkPushResult> {
  const token     = await getMpesaToken();
  const shortcode = process.env.MPESA_SHORTCODE!;
  const { password, timestamp } = makePassword();

  const resp = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(amountKes),
      PartyA:            phone,
      PartyB:            shortcode,
      PhoneNumber:       phone,
      CallBackURL:       callbackUrl,
      AccountReference:  accountReference.slice(0, 12),
      TransactionDesc:   description.slice(0, 13),
    }),
  });

  const data = (await resp.json()) as any;
  if (data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || 'STK push rejected by M-Pesa');
  }
  return data as StkPushResult;
}

// ─── STK Push status query ────────────────────────────────────────────────────
export interface StkQueryResult {
  ResponseCode:        string;
  ResponseDescription: string;
  MerchantRequestID:   string;
  CheckoutRequestID:   string;
  ResultCode:          string;
  ResultDesc:          string;
}

export async function queryStkStatus(checkoutRequestId: string): Promise<StkQueryResult> {
  const token     = await getMpesaToken();
  const shortcode = process.env.MPESA_SHORTCODE!;
  const { password, timestamp } = makePassword();

  const resp = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });

  return (await resp.json()) as StkQueryResult;
}
