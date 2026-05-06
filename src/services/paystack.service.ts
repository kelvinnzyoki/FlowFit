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
 *   [PS-5] Removed serverless-unsafe background intervals from verification.
 *          Verification now does bounded synchronous polling for Paystack
 *          subscription_code/email_token, while ACTIVE entitlement remains
 *          independent from those management-only fields.
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

export interface PaystackSubscriptionCreate {
  subscription_code: string;
  email_token:       string;
  status:            string;
  next_payment_date: string | null;
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
// ─── Checkout (transaction init with Paystack Plan linking) ─────────────────
/**
 * Initialise a Paystack transaction linked to a Paystack Plan.
 *
 * THE FIX FOR NULL subscriptionCode / emailToken:
 * Without passing `plan` (plan_code) to /transaction/initialize, Paystack
 * creates a one-time charge — NOT a recurring subscription. A one-time charge
 * has no Subscription object, so /transaction/verify returns no subscriptionCode
 * or emailToken, and the subscription.create webhook never fires.
 *
 * By passing plan_code, Paystack:
 *   1. Creates a Subscription object on their side.
 *   2. Returns subscription_code + email_token in the charge.success webhook.
 *   3. Returns subscription data in /transaction/verify.
 *   4. Enables the billing portal (manage.paystack.co needs emailToken).
 *
 * Requires: Plan.paystackPlanCodeMonthly / Yearly to be set in the DB.
 * These are created in your Paystack dashboard under Products → Plans.
 */
export async function createPaystackCheckout(
  userId:      string,
  email:       string,
  name:        string | null,
  planId:      string,
  interval:    BillingInterval,
  callbackUrl: string | undefined,
): Promise<PaystackTransactionInit & { subscriptionId: string }> {
  const plan = await prisma.plan.findUnique({
    where:  { id: planId },
    select: {
      id:                      true,
      name:                    true,
      monthlyPriceCents:       true,
      yearlyPriceCents:        true,
      paystackPlanCodeMonthly: true,
      paystackPlanCodeYearly:  true,
    },
  });
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const planCode = interval === 'YEARLY'
    ? plan.paystackPlanCodeYearly
    : plan.paystackPlanCodeMonthly;

  const amountKobo = interval === 'YEARLY'
    ? plan.yearlyPriceCents
    : plan.monthlyPriceCents;

  const customerCode = await getOrCreatePaystackCustomer(prisma, userId, email, name);
  const reference    = `ff_${userId.replace(/-/g, '').slice(0, 12)}_${Date.now()}`;

  // Upsert INCOMPLETE row so verifyPaystackPayment can find it on callback
  let subRow = await prisma.subscription.findFirst({
    where: { userId, planId, status: 'INCOMPLETE' },
  });
  if (subRow) {
    subRow = await prisma.subscription.update({
      where: { id: subRow.id },
      data:  { paystackReference: reference, interval, paystackCustomerCode: customerCode },
    });
  } else {
    subRow = await prisma.subscription.create({
      data: {
        userId,
        planId,
        status:               'INCOMPLETE',
        provider:             'PAYSTACK',
        interval,
        paystackReference:    reference,
        paystackCustomerCode: customerCode,
        cancelAtPeriodEnd:    false,
      },
    });
  }

  const appBase = (process.env.FRONTEND_URL || process.env.APP_URL || '').replace(/\/$/, '');
  const resolvedCallback = callbackUrl
    ?? (appBase ? `${appBase}/subscription?success=1&ref=${reference}` : undefined);

  const txPayload: Record<string, unknown> = {
    email,
    reference,
    currency:     'KES',
    callback_url: resolvedCallback,
    metadata: {
      userId,
      planId,
      interval,
      subscriptionId: subRow.id,
      customerCode,
    },
  };

  if (!planCode) {
    throw new Error(
      `Paystack plan code not set for plan "${plan.name}" / ${interval}. ` +
      `Set paystackPlanCode${interval === 'YEARLY' ? 'Yearly' : 'Monthly'} on the plans row. ` +
      'Without a Paystack plan_code, Paystack creates a one-time charge and will not return subscription_code/email_token.'
    );
  }

  // Linked to a Paystack Plan → Paystack creates a Subscription object
  // which carries subscriptionCode + emailToken on subscription.create.
  txPayload.plan = planCode;
  txPayload.amount = amountKobo;
  txPayload.channels = ['card'];

  const txn = await initializeTransaction(txPayload as any);
  
  console.log(`[createPaystackCheckout] Transaction initialized:`, {
  reference: txn.reference,
  hasPlan: !!txPayload.plan
});
  
  return { ...txn, subscriptionId: subRow.id };
}

/**
 * Programmatically create a Paystack Subscription after a one-time payment.
 *
 * WHY THIS EXISTS:
 * When paystackPlanCodeMonthly/Yearly is set in the Plan, Paystack automatically
 * creates a Subscription when `plan` is passed to /transaction/initialize.
 * subscription.create webhook fires and we get subscription_code + email_token.
 *
 * When plan_code is NOT set (fallback one-time charge), no Subscription is
 * created on Paystack's side. This function fills that gap — it calls
 * POST /subscription to create the Subscription manually, then stores the
 * resulting subscription_code and email_token in our DB.
 *
 * Without this, cancellation, reactivation, and the billing portal all fail
 * because they all require subscription_code + email_token.
 */
export async function createPaystackSubscription(
  customerCode: string,
  planCode:     string,
  startDate?:   Date,
): Promise<PaystackSubscriptionCreate> {
  const body: Record<string, unknown> = {
    customer: customerCode,
    plan:     planCode,
  };
  if (startDate) {
    body.start_date = startDate.toISOString();
  }
  return paystackRequest<PaystackSubscriptionCreate>('POST', '/subscription', body);
}

/**
 * Given a customer code, find the most recent Paystack subscription across
 * all plans for that customer. Used as a fallback to discover subscription_code
 * when the webhook hasn't fired yet or when plan_code was set after checkout.
 */
export function extractPaystackManagementCodes(payload: Record<string, any> | null | undefined): {
  subscriptionCode?: string;
  emailToken?: string;
  nextPaymentDate?: Date;
} {
  if (!payload) return {};

  const subscription = payload.subscription ?? payload.paystack_subscription ?? payload.data?.subscription;

  const subscriptionCode =
    (typeof subscription === 'string' ? subscription : undefined) ||
    subscription?.subscription_code ||
    payload.subscription_code ||
    payload.paystackSubscriptionCode ||
    payload.data?.subscription_code;

  const emailToken =
    subscription?.email_token ||
    payload.email_token ||
    payload.paystackEmailToken ||
    payload.data?.email_token;

  const rawNextPaymentDate =
    subscription?.next_payment_date ||
    payload.next_payment_date ||
    payload.data?.next_payment_date;

  return {
    subscriptionCode: subscriptionCode || undefined,
    emailToken:       emailToken       || undefined,
    nextPaymentDate:  rawNextPaymentDate ? new Date(rawNextPaymentDate) : undefined,
  };
}

/**
 * Given a customer code, find the most recent Paystack subscription across
 * all plans for that customer. Used to discover subscription_code/email_token
 * when transaction.verify does not include the full subscription object yet.
 */
export async function findPaystackSubscriptionByCustomer(
  customerCode: string,
): Promise<PaystackSubscriptionCreate | null> {
  try {
    const result = await paystackRequest<any>(
      'GET',
      `/subscription?customer=${encodeURIComponent(customerCode)}&perPage=20&page=1`,
    );

    const list: any[] = Array.isArray(result) ? result : (result?.data ?? []);
    const usable = list
      .filter(s => s?.subscription_code && s?.email_token)
      .sort((a, b) => {
        const ad = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
        const bd = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
        return bd - ad;
      });

    if (!usable.length) return null;
    const s = usable[0];
    return {
      subscription_code: s.subscription_code,
      email_token:       s.email_token,
      status:            s.status,
      next_payment_date: s.next_payment_date ?? null,
    };
  } catch (err: any) {
    console.warn('[findPaystackSubscriptionByCustomer] failed:', err?.message ?? err);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchAndStorePaystackCodes(params: {
  subscriptionId: string;
  customerCode?: string | null;
  subscriptionCode?: string | null;
  emailToken?: string | null;
  attempts?: number;
  delayMs?: number;
}): Promise<{ ok: boolean; subscriptionCode?: string; emailToken?: string; nextPaymentDate?: Date }> {
  const {
    subscriptionId,
    customerCode,
    subscriptionCode: initialSubscriptionCode,
    emailToken: initialEmailToken,
    attempts = 12,
    delayMs = 2_500,
  } = params;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const existing = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          paystackSubscriptionCode: true,
          paystackEmailToken:       true,
          currentPeriodEnd:         true,
        },
      });

      if (existing?.paystackSubscriptionCode && existing?.paystackEmailToken) {
        return {
          ok: true,
          subscriptionCode: existing.paystackSubscriptionCode,
          emailToken:       existing.paystackEmailToken,
          nextPaymentDate:  existing.currentPeriodEnd ?? undefined,
        };
      }

      let subscriptionCode = initialSubscriptionCode || existing?.paystackSubscriptionCode || undefined;
      let emailToken       = initialEmailToken       || existing?.paystackEmailToken       || undefined;
      let nextPaymentDate: Date | undefined;

      if (subscriptionCode && !emailToken) {
        try {
          const fetched = await fetchPaystackSubscription(subscriptionCode);
          emailToken = fetched.email_token || emailToken;
          if (fetched.next_payment_date) nextPaymentDate = new Date(fetched.next_payment_date);
        } catch (err: any) {
          console.warn('[fetchAndStorePaystackCodes] fetch by subscription_code failed:', err?.message ?? err);
        }
      }

      if ((!subscriptionCode || !emailToken) && customerCode) {
        const found = await findPaystackSubscriptionByCustomer(customerCode);
        subscriptionCode = subscriptionCode || found?.subscription_code || undefined;
        emailToken       = emailToken       || found?.email_token       || undefined;
        if (found?.next_payment_date) nextPaymentDate = new Date(found.next_payment_date);
      }

      if (subscriptionCode && emailToken) {
        await prisma.subscription.update({
          where: { id: subscriptionId },
          data: {
            paystackSubscriptionCode: subscriptionCode,
            paystackEmailToken:       emailToken,
            ...(nextPaymentDate ? { currentPeriodEnd: nextPaymentDate } : {}),
          },
        });

        console.log(
          `[fetchAndStorePaystackCodes] Stored Paystack management codes for sub ${subscriptionId} on attempt ${attempt}.`,
        );

        return { ok: true, subscriptionCode, emailToken, nextPaymentDate };
      }
    } catch (err: any) {
      console.warn(
        `[fetchAndStorePaystackCodes] attempt ${attempt}/${attempts} failed:`,
        err?.message ?? err,
      );
    }

    if (attempt < attempts) await sleep(delayMs);
  }

  console.warn(
    `[fetchAndStorePaystackCodes] Codes unavailable after polling for sub ${subscriptionId}. ` +
    'Subscription will remain INCOMPLETE until subscription.create stores both fields.',
  );

  return { ok: false };
}

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

  let sub = await prisma.subscription.findFirst({
    where:   { paystackReference: reference, userId },
    include: { plan: true },
  });

  if (!sub) {
    sub = await prisma.subscription.findFirst({
      where:   { userId, provider: 'PAYSTACK', status: { in: ['INCOMPLETE', 'ACTIVE'] } },
      include: { plan: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  if (!sub) {
    return {
      success: false,
      status:  'missing_subscription',
      message: 'Payment verified, but no matching subscription row was found.',
    };
  }

  const now      = new Date();
  const interval = (sub.interval ?? 'MONTHLY') as BillingInterval;
  const customerCode =
    txn.customer?.customer_code ||
    txn.customer_code ||
    sub.paystackCustomerCode ||
    undefined;

  const directCodes = extractPaystackManagementCodes(txn);

  const codeResult = await fetchAndStorePaystackCodes({
    subscriptionId:    sub.id,
    customerCode,
    subscriptionCode: directCodes.subscriptionCode,
    emailToken:       directCodes.emailToken,
    attempts:         12,
    delayMs:          2_500,
  });

  if (!codeResult.ok) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:               'INCOMPLETE',
        provider:             'PAYSTACK',
        paystackReference:    reference,
        paystackCustomerCode: customerCode ?? sub.paystackCustomerCode,
      },
    });

    await logPaystackActivationIssue(sub.id, reference, {
      reason:       'missing_paystack_management_codes',
      hasCustomer:  !!customerCode,
      hasSubCode:   !!directCodes.subscriptionCode,
      hasEmailToken:!!directCodes.emailToken,
    });

    return {
      success: false,
      status:  'pending_subscription_codes',
      message: 'Payment was received, but Paystack has not returned subscription_code/email_token yet. Subscription not activated.',
      subscription: await fetchCurrentSub(userId),
    };
  }

  let nextPaymentDate = codeResult.nextPaymentDate || directCodes.nextPaymentDate;
  if (!nextPaymentDate || Number.isNaN(nextPaymentDate.getTime())) {
    nextPaymentDate = new Date(now);
    if (interval === 'YEARLY') nextPaymentDate.setFullYear(nextPaymentDate.getFullYear() + 1);
    else nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
  }

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.subscription.findUnique({ where: { id: sub!.id } });
    if (!fresh) throw new Error('Subscription disappeared during verification');

    await tx.subscription.update({
      where: { id: sub!.id },
      data: {
        status:                   'ACTIVE',
        provider:                 'PAYSTACK',
        currentPeriodStart:       now,
        currentPeriodEnd:         nextPaymentDate,
        activatedAt:              fresh.activatedAt ?? now,
        cancelAtPeriodEnd:        false,
        paystackReference:        reference,
        paystackCustomerCode:     customerCode ?? fresh.paystackCustomerCode,
        paystackSubscriptionCode: codeResult.subscriptionCode!,
        paystackEmailToken:       codeResult.emailToken!,
      },
    });

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
        event:          fresh.status === 'ACTIVE' ? 'PAYMENT_SUCCEEDED' : 'ACTIVATED',
        previousStatus: fresh.status,
        newStatus:      'ACTIVE',
        metadata: {
          paystackReference: reference,
          note:              'activated_after_codes_confirmed',
          hasSubCode:         true,
          hasEmailToken:      true,
        },
      },
    });
  });

  return { success: true, status: 'success', subscription: await fetchCurrentSub(userId) };
}

async function logPaystackActivationIssue(
  subscriptionId: string,
  reference: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.subscriptionLog.create({
      data: {
        subscriptionId,
        event:     'WEBHOOK_RECEIVED',
        metadata:  { paystackReference: reference, ...metadata },
      } as any,
    });
  } catch (err) {
    console.warn('[logPaystackActivationIssue] failed:', err);
  }
}

// FIX-V2: Defined at module level in this file to avoid circular import.
// (subscription.service.ts imports from paystack.service.ts; importing it
// back here creates a circular dep that can silently fail at runtime.)
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
