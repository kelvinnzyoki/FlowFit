/**
 * FLOWFIT — Paystack Service
 *
 * Single shared Paystack client and helpers.
 * Replaces stripe.service.ts 1-for-1.
 *
 * Env vars required:
 *   PAYSTACK_SECRET_KEY      — sk_live_xxx or sk_test_xxx
 *   PAYSTACK_WEBHOOK_SECRET  — optional; falls back to PAYSTACK_SECRET_KEY
 *   FRONTEND_URL             — used for portal / callback redirect
 *
 * FIXES:
 *   [PS-1] Added initializeTransaction — wraps POST /transaction/initialize.
 *          Imported by subscription.service.ts but was missing from this file.
 *   [PS-2] Added disableSubscription / enableSubscription as named aliases for
 *          disablePaystackSubscription / enablePaystackSubscription.
 *          subscription.service.ts imports them under the shorter alias names.
 *   [PS-3] Added verifyPaystackPayment — verifies a Paystack transaction by
 *          reference and activates the linked INCOMPLETE subscription row.
 *          Imported by subscription_routes.ts for GET /paystack/verify/:reference.
 *   [PS-4] Exported verifyPaystackWebhook from both named + default export.
 */

import crypto from 'crypto';
import { BillingInterval } from '@prisma/client';
import prisma  from '../config/db.js';
import type { CurrentSubscription, PlanSlug } from '../types/subscription.types.js';

if (!process.env.PAYSTACK_SECRET_KEY) {
  throw new Error('PAYSTACK_SECRET_KEY env var is required');
}

const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const BASE_URL   = 'https://api.paystack.co';

// ─── Paystack response shape ──────────────────────────────────────────────────
interface PaystackResponse<T> {
  status:  boolean;
  message: string;
  data:    T;
}

// ─── Core types ───────────────────────────────────────────────────────────────
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
  /** Required for enable/disable calls — persist in DB. */
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

// [PS-1] Return shape for transaction/initialize
export interface PaystackTransactionInit {
  authorization_url: string;
  access_code:       string;
  reference:         string;
}

export interface PaystackWebhookEvent {
  event: string;
  data:  Record<string, any>;
}

// [PS-3] Return shape for verifyPaystackPayment
export interface VerifyPaymentResult {
  success:       boolean;
  status:        string;
  message?:      string;
  subscription?: CurrentSubscription | null;
}

// ─── HTTP client ──────────────────────────────────────────────────────────────
export async function paystackRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path:   string,
  body?:  Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${SECRET_KEY}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as PaystackResponse<T>;
  if (!json.status) throw new Error(`Paystack API error (${path}): ${json.message}`);
  return json.data;
}

// ─── [PS-1] Transaction initialise ───────────────────────────────────────────
/**
 * Initialise a Paystack transaction.
 * Returns { authorization_url, access_code, reference }.
 * Wraps POST /transaction/initialize.
 */
export async function initializeTransaction(payload: {
  email:         string;
  amount:        number;
  currency?:     string;
  plan?:         string;
  channels?:     Array<'card' | 'bank' | 'ussd' | 'qr' | 'mobile_money' | 'bank_transfer'>;
  callback_url?: string;
  metadata?:     Record<string, unknown>;
}): Promise<PaystackTransactionInit> {
  return paystackRequest<PaystackTransactionInit>(
    'POST',
    '/transaction/initialize',
    payload as Record<string, unknown>,
  );
}

// ─── Customer ─────────────────────────────────────────────────────────────────
/**
 * Ensure a Paystack customer exists for this user.
 * Creates one if not present and persists customer_code on the User row.
 */
export async function getOrCreatePaystackCustomer(
  prismaClient: any,
  userId:       string,
  email:        string,
  name?:        string | null,
): Promise<string> {
  const user = await prismaClient.user.findUnique({
    where:  { id: userId },
    select: { paystackCustomerCode: true },
  });
  if (user?.paystackCustomerCode) return user.paystackCustomerCode as string;

  const parts     = (name ?? '').trim().split(/\s+/);
  const firstName = parts[0]                 || undefined;
  const lastName  = parts.slice(1).join(' ') || undefined;

  const customer = await paystackRequest<PaystackCustomer>('POST', '/customer', {
    email,
    first_name: firstName,
    last_name:  lastName,
    metadata:   { userId },
  });

  await prismaClient.user.update({
    where: { id: userId },
    data:  { paystackCustomerCode: customer.customer_code },
  });

  return customer.customer_code;
}

// ─── Subscription helpers ─────────────────────────────────────────────────────
export async function fetchPaystackSubscription(
  subscriptionCode: string,
): Promise<PaystackSubscription> {
  return paystackRequest<PaystackSubscription>('GET', `/subscription/${subscriptionCode}`);
}

/** Disable (cancel) a Paystack subscription. Requires subscription code + email token. */
export async function disablePaystackSubscription(
  code:       string,
  emailToken: string,
): Promise<void> {
  await paystackRequest<unknown>('POST', '/subscription/disable', {
    code,
    token: emailToken,
  });
}

/** Enable (reactivate) a Paystack subscription. Requires subscription code + email token. */
export async function enablePaystackSubscription(
  code:       string,
  emailToken: string,
): Promise<void> {
  await paystackRequest<unknown>('POST', '/subscription/enable', {
    code,
    token: emailToken,
  });
}

// [PS-2] Short-name aliases — subscription.service.ts imports these names.
export const disableSubscription = disablePaystackSubscription;
export const enableSubscription  = enablePaystackSubscription;

// ─── [PS-3] Payment verification ─────────────────────────────────────────────
/**
 * Verify a Paystack transaction by reference and activate the linked subscription.
 * Called from GET /subscriptions/paystack/verify/:reference (poll after redirect).
 *
 * Flow:
 *  1. GET /transaction/verify/:reference from Paystack.
 *  2. If status !== 'success' → return { success: false }.
 *  3. Find the INCOMPLETE subscription row with paystackReference = reference.
 *  4. If already ACTIVE (webhook beat us) → return current subscription.
 *  5. Otherwise activate, create Payment, log event.
 */
export async function verifyPaystackPayment(
  reference: string,
  userId:    string,
): Promise<VerifyPaymentResult> {
  // 1. Verify with Paystack
  const txn = await paystackRequest<Record<string, any>>(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );

  if (txn.status !== 'success') {
    return {
      success: false,
      status:  txn.status as string,
      message: `Payment status is "${txn.status}". Expected "success".`,
    };
  }

  // 2. Find our INCOMPLETE subscription row for this reference
  let sub = await prisma.subscription.findFirst({
    where:   { paystackReference: reference, userId },
    include: { plan: true },
  });

  // Fallback: if webhook already activated it, find the ACTIVE row
  if (!sub) {
    sub = await prisma.subscription.findFirst({
      where:   { userId, status: 'ACTIVE', provider: 'PAYSTACK' },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    if (sub) {
      // Webhook already activated — return current state
      return { success: true, status: 'success', subscription: await fetchCurrentSub(userId) };
    }
    return {
      success: false,
      status:  txn.status as string,
      message: 'No pending subscription found for this reference.',
    };
  }

  if (sub.status === 'ACTIVE') {
    // Already activated (webhook beat us or prior poll)
    return { success: true, status: 'success', subscription: await fetchCurrentSub(userId) };
  }

  // 3. Activate the INCOMPLETE row
  const now              = new Date();
  const subscriptionCode = txn.subscription?.subscription_code as string | undefined;
  const emailToken       = txn.subscription?.email_token        as string | undefined;
  const interval         = (sub.interval ?? 'MONTHLY') as BillingInterval;

  // FIX-V1: Calculate nextPaymentDate from interval when Paystack omits it.
  // Previously set to `now` causing the subscription to appear expired immediately.
  let nextPaymentDate: Date;
  if (txn.subscription?.next_payment_date) {
    nextPaymentDate = new Date(txn.subscription.next_payment_date as string);
  } else {
    nextPaymentDate = new Date(now);
    if (interval === 'YEARLY') {
      nextPaymentDate.setFullYear(nextPaymentDate.getFullYear() + 1);
    } else {
      nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub!.id },
      data: {
        status:             'ACTIVE',
        provider:           'PAYSTACK',
        currentPeriodStart: now,
        currentPeriodEnd:   nextPaymentDate,
        activatedAt:        now,
        cancelAtPeriodEnd:  false,
        // FIX: Only write subscription codes when Paystack actually returned them.
        // /transaction/verify often omits subscription.subscription_code and
        // email_token — especially when called immediately after redirect before
        // Paystack has fully linked the subscription. Writing null here would
        // overwrite values already stored by the subscription.create webhook.
        // Use undefined (not null) so Prisma skips the field entirely when absent.
        ...(subscriptionCode ? { paystackSubscriptionCode: subscriptionCode } : {}),
        ...(emailToken       ? { paystackEmailToken:       emailToken       } : {}),
      },
    });

    // Only create a Payment record if one doesn't exist for this reference
    const existingPayment = await tx.payment.findFirst({
      where: { paystackReference: reference },
    });
    if (!existingPayment) {
      await tx.payment.create({
        data: {
          subscriptionId:    sub!.id,
          paystackReference: reference,
          amountCents:       txn.amount as number,
          currency:          ((txn.currency as string) ?? 'KES').toUpperCase(),
          status:            'succeeded',
          paidAt:            now,
          provider:          'PAYSTACK',
        },
      });
    }

    await tx.subscriptionLog.create({
      data: {
        subscriptionId: sub!.id,
        event:          'ACTIVATED',
        previousStatus: sub!.status,
        newStatus:      'ACTIVE',
        metadata: { paystackReference: reference, note: 'activated_by_client_verify' },
      },
    });
  });

  return { success: true, status: 'success', subscription: await fetchCurrentSub(userId) };
}

// FIX-V2: Inline fetchCurrentSub to avoid circular import.
// subscription.service.ts imports from paystack.service.ts, so lazily importing
// subscription.service.ts here creates a circular dep that can fail at runtime.
async function fetchCurrentSub(userId: string) {
  const sub = await prisma.subscription.findFirst({
    where:   {
      userId,
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD'] },
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!sub) return null;

  const interval: BillingInterval = sub.interval ?? 'MONTHLY';

  return {
    id:                       sub.id,
    status:                   sub.status,
    interval,
    plan: {
      id:                   sub.plan?.id   ?? '',
      slug:                 (sub.plan?.slug ?? 'pro') as PlanSlug,
      name:                 sub.plan?.name ?? 'Pro',
      description:          (sub.plan as any)?.description          ?? null,
      monthlyPriceCents:    (sub.plan as any)?.monthlyPriceCents    ?? 0,
      yearlyPriceCents:     (sub.plan as any)?.yearlyPriceCents     ?? 0,
      trialDays:            (sub.plan as any)?.trialDays            ?? 0,
      maxWorkoutsPerMonth:  (sub.plan as any)?.maxWorkoutsPerMonth  ?? null,
      maxPrograms:          (sub.plan as any)?.maxPrograms          ?? null,
      hasAdvancedAnalytics: (sub.plan as any)?.hasAdvancedAnalytics ?? false,
      hasPersonalCoaching:  (sub.plan as any)?.hasPersonalCoaching  ?? false,
      hasNutritionTracking: (sub.plan as any)?.hasNutritionTracking ?? false,
      hasOfflineAccess:     (sub.plan as any)?.hasOfflineAccess     ?? false,
      features:             Array.isArray((sub.plan as any)?.features)
                              ? (sub.plan as any).features
                              : [],
      displayOrder:         (sub.plan as any)?.displayOrder ?? 0,
      isPopular:            (sub.plan as any)?.isPopular    ?? false,
    },
    trialEndsAt:              sub.trialEndsAt?.toISOString()         ?? null,
    currentPeriodStart:       sub.currentPeriodStart?.toISOString()  ?? null,
    currentPeriodEnd:         sub.currentPeriodEnd?.toISOString()    ?? null,
    cancelAtPeriodEnd:        sub.cancelAtPeriodEnd                  ?? false,
    cancelledAt:              sub.cancelledAt?.toISOString()         ?? null,
    scheduledPlanSlug:        null,
    activatedAt:              sub.activatedAt?.toISOString()         ?? null,
    daysUntilRenewal:         sub.currentPeriodEnd
                                ? Math.max(0, Math.ceil(
                                    (sub.currentPeriodEnd.getTime() - Date.now()) / 86_400_000,
                                  ))
                                : null,
    paystackSubscriptionCode: sub.paystackSubscriptionCode           ?? null,
    paystackEmailToken:       sub.paystackEmailToken                 ?? null,
  };
}

// ─── Webhook verification ─────────────────────────────────────────────────────
/**
 * Verify a Paystack webhook signature and parse the event.
 * Paystack signs with HMAC-SHA512 using the secret key.
 * The raw body must be the exact bytes Paystack sent — do not JSON.parse first.
 */
export function verifyPaystackWebhook(
  rawBody:   Buffer | string,
  signature: string,
): PaystackWebhookEvent {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET ?? SECRET_KEY;
  const body   = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  const expected = crypto
    .createHmac('sha512', secret)
    .update(body)
    .digest('hex');

  if (expected !== signature) {
    throw new Error('Invalid Paystack webhook signature');
  }

  return JSON.parse(body) as PaystackWebhookEvent;
}

export default {
  paystackRequest,
  initializeTransaction,
  getOrCreatePaystackCustomer,
  fetchPaystackSubscription,
  disablePaystackSubscription,
  enablePaystackSubscription,
  disableSubscription,
  enableSubscription,
  verifyPaystackPayment,
  verifyPaystackWebhook,
};
