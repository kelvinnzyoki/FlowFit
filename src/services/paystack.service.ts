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
      slug:                    true,
      name:                    true,
      mpesaMonthlyKes:         true,
      mpesaYearlyKes:          true,
      paystackPlanCodeMonthly: true,
      paystackPlanCodeYearly:  true,
    },
  });
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const planCode = interval === 'YEARLY'
    ? plan.paystackPlanCodeYearly
    : plan.paystackPlanCodeMonthly;

  if (!planCode) {
    throw new Error(
      `Paystack plan code not set for plan "${plan.slug}" / ${interval}. ` +
      `Without a Paystack plan code, Paystack cannot create subscription_code/email_token.`
    );
  }

  const amountKes = interval === 'YEARLY'
    ? plan.mpesaYearlyKes
    : plan.mpesaMonthlyKes;

  if (!amountKes || amountKes <= 0) {
    throw new Error(`KES price not configured for plan "${plan.slug}" / ${interval}`);
  }

  const customerCode = await getOrCreatePaystackCustomer(prisma, userId, email, name);
  const reference    = `ff_${userId.replace(/-/g, '').slice(0, 12)}_${Date.now()}`;

  const subRow = await prisma.subscription.create({
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

  const appBase = (process.env.FRONTEND_URL || process.env.APP_URL || '').replace(/\/$/, '');
  const resolvedCallback = callbackUrl
    ?? (appBase ? `${appBase}/subscription.html?success=1` : undefined);

  const txn = await initializeTransaction({
    email,
    amount:       amountKes * 100,
    reference,
    currency:     'KES',
    // Do not pass `plan` here. The verified transaction authorization is used
    // to create the Paystack subscription with a future start_date after payment.
    channels:     ['card'],
    callback_url: resolvedCallback,
    metadata: {
      userId,
      planId,
      interval,
      subscriptionId: subRow.id,
      customerCode,
      planCode,
    },
  } as any);

  console.log('[createPaystackCheckout] Transaction initialized:', {
    reference: txn.reference,
    subscriptionId: subRow.id,
    planCode,
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
  authorizationCode?: string | null,
): Promise<PaystackSubscriptionCreate> {
  const body: Record<string, unknown> = {
    customer: customerCode,
    plan:     planCode,
  };
  if (authorizationCode) body.authorization = authorizationCode;
  if (startDate) body.start_date = startDate.toISOString();
  return paystackRequest<PaystackSubscriptionCreate>('POST', '/subscription', body);
}

function getCustomerCodeFromPaystackValue(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.customer_code ?? value.customerCode ?? null;
}

function getAuthorizationCodeFromTransaction(txn: Record<string, any>): string | null {
  const auth = txn.authorization;
  if (!auth || typeof auth !== 'object') return null;
  return auth.authorization_code ?? auth.authorizationCode ?? null;
}

function normalizePaystackSubscription(raw: any): PaystackSubscriptionCreate | null {
  if (!raw) return null;

  const subscription = typeof raw === 'object' && raw.data ? raw.data : raw;
  const subscriptionCode =
    subscription.subscription_code ??
    subscription.subscriptionCode ??
    (typeof subscription === 'string' ? subscription : null);

  if (!subscriptionCode) return null;

  return {
    subscription_code: subscriptionCode,
    email_token:       subscription.email_token ?? subscription.emailToken ?? '',
    status:            subscription.status ?? '',
    next_payment_date: subscription.next_payment_date ?? subscription.nextPaymentDate ?? null,
  };
}

async function fetchPaystackSubscriptionCodesByCode(
  subscriptionCode: string,
): Promise<PaystackSubscriptionCreate | null> {
  try {
    const sub = await paystackRequest<any>(
      'GET',
      `/subscription/${encodeURIComponent(subscriptionCode)}`,
    );
    return normalizePaystackSubscription(sub);
  } catch (err: any) {
    console.warn('[paystack] fetch subscription by code failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Given a customer code, find the most recent Paystack subscription across
 * all plans for that customer. This function is deliberately defensive because
 * Paystack list responses can be either an array or a paginated payload depending
 * on wrapper shape.
 */
export async function findPaystackSubscriptionByCustomer(
  customerCode: string,
  planCode?: string | null,
): Promise<PaystackSubscriptionCreate | null> {
  try {
    const result = await paystackRequest<any>(
      'GET',
      `/subscription?customer=${encodeURIComponent(customerCode)}&perPage=50&page=1`,
    );

    const list: any[] = Array.isArray(result)
      ? result
      : Array.isArray(result?.data)
        ? result.data
        : [];

    const matches = list
      .filter((s) => {
        const subCustomerCode = getCustomerCodeFromPaystackValue(s.customer);
        const subPlanCode = typeof s.plan === 'string'
          ? s.plan
          : s.plan?.plan_code ?? s.plan?.planCode ?? null;

        return (!subCustomerCode || subCustomerCode === customerCode) &&
          (!planCode || !subPlanCode || subPlanCode === planCode);
      })
      .sort((a, b) => {
        const ad = new Date(a.createdAt ?? a.created_at ?? a.updatedAt ?? a.updated_at ?? 0).getTime();
        const bd = new Date(b.createdAt ?? b.created_at ?? b.updatedAt ?? b.updated_at ?? 0).getTime();
        return bd - ad;
      });

    for (const item of matches) {
      const normalized = normalizePaystackSubscription(item);
      if (normalized?.subscription_code && normalized?.email_token) return normalized;
    }

    return null;
  } catch (err: any) {
    console.warn('[paystack] find subscription by customer failed:', err?.message ?? err);
    return null;
  }
}

async function resolvePaystackCodesFromTransaction(params: {
  txn: Record<string, any>;
  customerCode: string;
  planCode: string;
  startDate?: Date;
}): Promise<PaystackSubscriptionCreate | null> {
  const { txn, customerCode, planCode, startDate } = params;

  const direct = normalizePaystackSubscription(txn.subscription);
  if (direct?.subscription_code) {
    if (direct.email_token) return direct;

    const fetched = await fetchPaystackSubscriptionCodesByCode(direct.subscription_code);
    if (fetched?.subscription_code && fetched?.email_token) return fetched;
  }

  const found = await findPaystackSubscriptionByCustomer(customerCode, planCode);
  if (found?.subscription_code && found?.email_token) return found;

  const authorizationCode = getAuthorizationCodeFromTransaction(txn);
  if (authorizationCode) {
    const created = await createPaystackSubscription(
      customerCode,
      planCode,
      startDate,
      authorizationCode,
    ).catch((err: any) => {
      console.warn('[paystack] create subscription from verified authorization failed:', err?.message ?? err);
      return null;
    });

    if (created?.subscription_code) {
      if (created.email_token) return created;

      const fetchedCreated = await fetchPaystackSubscriptionCodesByCode(created.subscription_code);
      if (fetchedCreated?.subscription_code && fetchedCreated?.email_token) return fetchedCreated;
    }
  }

  return null;
}

export async function resolveAndStorePaystackSubscriptionCodes(params: {
  subscriptionId: string;
  txn?: Record<string, any> | null;
  attempts?: number;
  delayMs?: number;
}): Promise<PaystackSubscriptionCreate | null> {
  const attempts = params.attempts ?? 6;
  const delayMs = params.delayMs ?? 2_000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const sub = await prisma.subscription.findUnique({
      where: { id: params.subscriptionId },
      include: { plan: true },
    });

    if (!sub) throw new Error(`Subscription ${params.subscriptionId} not found`);

    if (sub.paystackSubscriptionCode && sub.paystackEmailToken) {
      return {
        subscription_code: sub.paystackSubscriptionCode,
        email_token:       sub.paystackEmailToken,
        status:            'stored',
        next_payment_date: sub.currentPeriodEnd?.toISOString() ?? null,
      };
    }

    const planCode = sub.interval === 'YEARLY'
      ? sub.plan?.paystackPlanCodeYearly
      : sub.plan?.paystackPlanCodeMonthly;

    if (!planCode) {
      throw new Error(
        `Paystack plan code missing for ${sub.plan?.slug ?? sub.planId}/${sub.interval}. ` +
        `Cannot create/fetch subscription_code and email_token.`
      );
    }

    const customerCode =
      sub.paystackCustomerCode ??
      getCustomerCodeFromPaystackValue(params.txn?.customer);

    const subscriptionStartDate = sub.currentPeriodEnd ?? (() => {
      const d = new Date();
      if (sub.interval === 'YEARLY') d.setFullYear(d.getFullYear() + 1);
      else d.setMonth(d.getMonth() + 1);
      return d;
    })();

    if (!customerCode) {
      throw new Error('Paystack customer code missing. Cannot fetch subscription_code/email_token.');
    }

    const codes = params.txn
      ? await resolvePaystackCodesFromTransaction({ txn: params.txn, customerCode, planCode, startDate: subscriptionStartDate })
      : await findPaystackSubscriptionByCustomer(customerCode, planCode);

    if (codes?.subscription_code && codes?.email_token) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          paystackSubscriptionCode: codes.subscription_code,
          paystackEmailToken:       codes.email_token,
          paystackCustomerCode:     customerCode,
          ...(codes.next_payment_date
            ? { currentPeriodEnd: new Date(codes.next_payment_date) }
            : {}),
        },
      });

      console.log('[paystack] stored subscription management codes:', {
        subscriptionId: sub.id,
        subscriptionCode: codes.subscription_code,
        attempt,
      });

      return codes;
    }

    if (attempt < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

/**
 * Verify a Paystack transaction by reference. This function intentionally does
 * NOT activate the subscription until subscription_code and email_token have
 * been stored. If Paystack has not emitted subscription.create yet, it creates
 * the Paystack subscription immediately using the reusable authorization from
 * the successful transaction.
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

  const metadata = (txn.metadata ?? {}) as Record<string, any>;
  const metaSubscriptionId = metadata.subscriptionId as string | undefined;

  let sub = metaSubscriptionId
    ? await prisma.subscription.findFirst({
        where: { id: metaSubscriptionId, userId },
        include: { plan: true },
      })
    : null;

  if (!sub) {
    sub = await prisma.subscription.findFirst({
      where:   { paystackReference: reference, userId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!sub) {
    return {
      success: false,
      status:  'not_found',
      message: 'No pending subscription found for this verified payment reference.',
    };
  }

  const customerCode =
    sub.paystackCustomerCode ??
    getCustomerCodeFromPaystackValue(txn.customer);

  if (customerCode && !sub.paystackCustomerCode) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { paystackCustomerCode: customerCode },
    });
  }

  const codes = await resolveAndStorePaystackSubscriptionCodes({
    subscriptionId: sub.id,
    txn,
    attempts: 8,
    delayMs: 2_000,
  });

  if (!codes?.subscription_code || !codes.email_token) {
    return {
      success: false,
      status:  'pending_subscription_codes',
      message:
        'Payment succeeded, but Paystack subscription_code/email_token are not available yet. ' +
        'Retry verification shortly; the subscription will not be activated until both codes are stored.',
      subscription: await fetchCurrentSub(userId),
    };
  }

  const now = new Date();
  const interval = (sub.interval ?? 'MONTHLY') as BillingInterval;
  let nextPaymentDate: Date;
  if (codes.next_payment_date) {
    nextPaymentDate = new Date(codes.next_payment_date);
  } else if (txn.subscription?.next_payment_date) {
    nextPaymentDate = new Date(txn.subscription.next_payment_date as string);
  } else {
    nextPaymentDate = new Date(now);
    if (interval === 'YEARLY') nextPaymentDate.setFullYear(nextPaymentDate.getFullYear() + 1);
    else nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
  }

  const alreadyActive = sub.status === 'ACTIVE';

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub!.id },
      data: {
        status:                   'ACTIVE',
        provider:                 'PAYSTACK',
        currentPeriodStart:       sub!.currentPeriodStart ?? now,
        currentPeriodEnd:         nextPaymentDate,
        activatedAt:              sub!.activatedAt ?? now,
        cancelAtPeriodEnd:        false,
        paystackReference:        reference,
        paystackSubscriptionCode: codes.subscription_code,
        paystackEmailToken:       codes.email_token,
        ...(customerCode ? { paystackCustomerCode: customerCode } : {}),
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
          amountCents:       Number(txn.amount ?? 0),
          currency:          String(txn.currency ?? 'KES').toUpperCase(),
          status:            'succeeded',
          paidAt:            now,
          provider:          'PAYSTACK',
        },
      });
    }

    await tx.subscriptionLog.create({
      data: {
        subscriptionId: sub!.id,
        event:          alreadyActive ? 'PAYMENT_SUCCEEDED' : 'ACTIVATED',
        previousStatus: sub!.status,
        newStatus:      'ACTIVE',
        metadata: {
          paystackReference: reference,
          paystackSubscriptionCode: codes.subscription_code,
          note: 'verified_after_codes_stored',
        },
      },
    });
  });

  return { success: true, status: 'success', subscription: await fetchCurrentSub(userId) };
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
  resolveAndStorePaystackSubscriptionCodes,
  verifyPaystackWebhook,
};
