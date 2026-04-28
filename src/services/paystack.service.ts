/**
 * FLOWFIT — Paystack Service
 *
 * Single shared Paystack HTTP client and helpers.
 * Env vars:
 *   PAYSTACK_SECRET_KEY     — sk_live_xxx or sk_test_xxx
 *   PAYSTACK_WEBHOOK_SECRET — optional; falls back to PAYSTACK_SECRET_KEY
 *   FRONTEND_URL            — used for callback / portal redirects
 */

import crypto from 'crypto';

if (!process.env.PAYSTACK_SECRET_KEY) {
  throw new Error('PAYSTACK_SECRET_KEY env var is required');
}

const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const BASE_URL   = 'https://api.paystack.co';

// ─── Response wrapper ─────────────────────────────────────────────────────────
interface PaystackResponse<T> {
  status:  boolean;
  message: string;
  data:    T;
}

// ─── Public types ─────────────────────────────────────────────────────────────
export interface PaystackCustomer {
  id:            number;
  customer_code: string;
  email:         string;
  first_name:    string | null;
  last_name:     string | null;
}

export interface PaystackSubscription {
  id:                number;
  subscription_code: string;
  email_token:       string;
  status:            'active' | 'non-renewing' | 'attention' | 'completed' | 'cancelled';
  amount:            number;
  plan: {
    id:        number;
    plan_code: string;
    name:      string;
    amount:    number;
    interval:  string;
  };
  customer: {
    email:         string;
    customer_code: string;
  };
  next_payment_date: string | null;
  createdAt:         string;
  updatedAt:         string;
}

export interface PaystackWebhookEvent {
  event: string;
  data:  Record<string, any>;
}

export interface InitTransactionParams {
  email:        string;
  amount:       number;
  currency?:    string;
  plan?:        string;
  callback_url?: string;
  metadata?:    Record<string, unknown>;
}

export interface InitTransactionResult {
  authorization_url: string;
  access_code:       string;
  reference:         string;
}

export interface VerifyTransactionResult {
  status:       string;   // 'success' | 'failed' | 'abandoned' etc.
  reference:    string;
  amount:       number;
  currency:     string;
  paid_at:      string | null;
  metadata:     Record<string, any>;
  subscription?: {
    subscription_code: string;
    email_token:       string;
    next_payment_date: string | null;
  };
}

export interface VerifyPaymentResult {
  success:      boolean;
  status:       string;
  message?:     string;
  subscription?: any;   // CurrentSubscription shape — resolved by the caller
}

// ─── Core HTTP client ─────────────────────────────────────────────────────────
export async function paystackRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path:   string,
  body?:  Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as PaystackResponse<T>;
  if (!json.status) {
    throw new Error(`Paystack API error (${method} ${path}): ${json.message}`);
  }
  return json.data;
}

// ─── Customer ─────────────────────────────────────────────────────────────────
/**
 * Returns existing paystackCustomerCode for the user or creates a new
 * Paystack customer and persists the code.
 */
export async function getOrCreatePaystackCustomer(
  prisma:  any,
  userId:  string,
  email:   string,
  name?:   string | null,
): Promise<string> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { paystackCustomerCode: true },
  });
  if (user?.paystackCustomerCode) return user.paystackCustomerCode as string;

  const parts     = (name ?? '').trim().split(/\s+/);
  const firstName = parts[0]             || undefined;
  const lastName  = parts.slice(1).join(' ') || undefined;

  const customer = await paystackRequest<PaystackCustomer>('POST', '/customer', {
    email,
    first_name: firstName,
    last_name:  lastName,
    metadata:   { userId },
  });

  await prisma.user.update({
    where: { id: userId },
    data:  { paystackCustomerCode: customer.customer_code },
  });

  return customer.customer_code;
}

// ─── Transaction ──────────────────────────────────────────────────────────────
/**
 * POST /transaction/initialize
 * Creates a new Paystack transaction and returns the authorization URL.
 * If `plan` is provided, Paystack treats this as a recurring subscription charge.
 */
export async function initializeTransaction(
  params: InitTransactionParams,
): Promise<InitTransactionResult> {
  return paystackRequest<InitTransactionResult>('POST', '/transaction/initialize', {
    email:        params.email,
    amount:       params.amount,
    currency:     params.currency ?? 'KES',
    plan:         params.plan,
    callback_url: params.callback_url,
    metadata:     params.metadata,
  });
}

/**
 * GET /transaction/verify/:reference
 * Verifies a completed transaction. Returns a structured result the
 * subscription route can use directly without touching the Paystack API again.
 *
 * DB side-effect: if the matching subscription row is still INCOMPLETE,
 * activates it using data from the verified transaction.
 */
export async function verifyPaystackPayment(
  reference: string,
  userId:    string,
): Promise<VerifyPaymentResult> {
  let txData: VerifyTransactionResult;
  try {
    txData = await paystackRequest<VerifyTransactionResult>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  } catch (err: any) {
    return { success: false, status: 'error', message: err.message };
  }

  if (txData.status !== 'success') {
    return {
      success: false,
      status:  txData.status,
      message: `Payment status: ${txData.status}`,
    };
  }

  // Lazy import prisma to keep this module lightweight
  const { default: prisma } = await import('../config/db.js');

  // Find the INCOMPLETE subscription row linked to this reference
  const sub = await prisma.subscription.findFirst({
    where:   { paystackReference: reference, userId },
    include: { plan: true },
  });

  if (!sub) {
    // May already have been activated by the webhook — look for an ACTIVE one
    const active = await prisma.subscription.findFirst({
      where:   { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      success:      true,
      status:       txData.status,
      subscription: active ?? undefined,
    };
  }

  if (sub.status !== 'INCOMPLETE') {
    // Webhook already processed it
    return { success: true, status: txData.status, subscription: sub };
  }

  const now             = new Date();
  const nextPaymentDate = txData.subscription?.next_payment_date
    ? new Date(txData.subscription.next_payment_date)
    : null;

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status:                   'ACTIVE',
      provider:                 'PAYSTACK',
      paystackSubscriptionCode: txData.subscription?.subscription_code ?? null,
      paystackEmailToken:       txData.subscription?.email_token       ?? null,
      currentPeriodStart:       now,
      currentPeriodEnd:         nextPaymentDate ?? now,
      activatedAt:              now,
    },
    include: { plan: true },
  });

  await prisma.payment.create({
    data: {
      subscriptionId:    sub.id,
      paystackReference: reference,
      amountCents:       txData.amount,
      currency:          txData.currency ?? 'KES',
      status:            'succeeded',
      paidAt:            txData.paid_at ? new Date(txData.paid_at) : now,
    },
  });

  return { success: true, status: txData.status, subscription: updated };
}

// ─── Subscription management ──────────────────────────────────────────────────
export async function fetchPaystackSubscription(
  subscriptionCode: string,
): Promise<PaystackSubscription> {
  return paystackRequest<PaystackSubscription>('GET', `/subscription/${subscriptionCode}`);
}

/** Cancel a Paystack subscription. Requires the subscription_code + email_token. */
export async function disablePaystackSubscription(
  code:       string,
  emailToken: string,
): Promise<void> {
  await paystackRequest<unknown>('POST', '/subscription/disable', { code, token: emailToken });
}
// Alias used by subscription.service.ts
export const disableSubscription = disablePaystackSubscription;

/** Reactivate a disabled Paystack subscription. */
export async function enablePaystackSubscription(
  code:       string,
  emailToken: string,
): Promise<void> {
  await paystackRequest<unknown>('POST', '/subscription/enable', { code, token: emailToken });
}
// Alias used by subscription.service.ts
export const enableSubscription = enablePaystackSubscription;

// ─── Webhook signature verification ──────────────────────────────────────────
/**
 * Verifies a Paystack webhook using HMAC-SHA512.
 * The raw request body Buffer must be passed — do not parse to JSON first.
 * Signature is sent in the x-paystack-signature header.
 */
export function verifyPaystackWebhook(
  rawBody:   Buffer | string,
  signature: string,
): PaystackWebhookEvent {
  const secret   = process.env.PAYSTACK_WEBHOOK_SECRET ?? SECRET_KEY;
  const body     = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto.createHmac('sha512', secret).update(body).digest('hex');

  if (expected !== signature) {
    throw new Error('Invalid Paystack webhook signature');
  }

  return JSON.parse(body) as PaystackWebhookEvent;
}

export default {
  paystackRequest,
  initializeTransaction,
  verifyPaystackPayment,
  fetchPaystackSubscription,
  disablePaystackSubscription,
  disableSubscription,
  enablePaystackSubscription,
  enableSubscription,
};
