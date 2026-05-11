// SECURITY PATCHES APPLIED: FIX-1, FIX-3, FIX-6
/**
 * FLOWFIT — Paystack Service
 *
 * Core rules:
 * 1. Checkout MUST pass a Paystack plan_code to /transaction/initialize.
 * 2. A Paystack subscription is not considered usable until BOTH
 *    subscription_code and email_token are stored.
 * 3. Client verification must not mark the DB subscription ACTIVE unless
 *    those two management codes are present.
 * 4. subscription.create webhook is the authoritative source for codes.
 *
 * FIX SUMMARY (this revision):
 *
 * FIX-PS-1  REMOVED createPaystackSubscription FALLBACK FROM verifyPaystackPayment
 *           Previously, when charge succeeded but no codes were visible yet,
 *           verifyPaystackPayment called POST /subscription to create a second
 *           Paystack subscription using the authorization_code. This caused:
 *           (a) a duplicate active subscription on Paystack's side;
 *           (b) two subscription.create events — Paystack fires one for the
 *               plan-code subscription created at checkout AND one for the manual
 *               POST, so the wrong row can receive the codes;
 *           (c) the user being charged twice on the next billing cycle.
 *           The verify route now only calls findPaystackSubscriptionByCustomer
 *           (read-only). If codes are not ready yet it returns
 *           pending_subscription_codes and lets the authoritative
 *           subscription.create webhook complete activation.
 */

import crypto from 'crypto';
import { BillingInterval } from '@prisma/client';
import prisma from '../config/db.js';
import type { CurrentSubscription, PlanSlug } from '../types/subscription.types.js';

if (!process.env.PAYSTACK_SECRET_KEY) {
  throw new Error('PAYSTACK_SECRET_KEY env var is required');
}

const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const BASE_URL = 'https://api.paystack.co';

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface PaystackCustomer {
  id: number;
  customer_code: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export interface PaystackSubscription {
  id: number;
  subscription_code: string;
  email_token: string;
  status: 'active' | 'non-renewing' | 'attention' | 'completed' | 'cancelled' | string;
  amount: number;
  plan?: {
    id?: number;
    plan_code?: string;
    name?: string;
    amount?: number;
    interval?: string;
  };
  customer?: {
    email?: string;
    customer_code?: string;
  };
  next_payment_date?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PaystackSubscriptionCreate {
  subscription_code: string;
  email_token: string;
  status: string;
  next_payment_date: string | null;
}

export interface PaystackTransactionInit {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackWebhookEvent {
  event: string;
  data: Record<string, any>;
}

export interface VerifyPaymentResult {
  success: boolean;
  status: string;
  message?: string;
  subscription?: CurrentSubscription | null;
  pending?: boolean;
}

function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from);
  if (interval === 'YEARLY') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function pickSubscriptionCode(obj: any): string | undefined {
  return obj?.subscription?.subscription_code
    ?? obj?.subscription_code
    ?? obj?.subscription?.code
    ?? undefined;
}

function pickEmailToken(obj: any): string | undefined {
  return obj?.subscription?.email_token
    ?? obj?.email_token
    ?? undefined;
}

export async function paystackRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  // FIX-13: 15-second hard timeout on every Paystack API call. Without this a slow
  // Paystack response holds the webhook handler open until Vercel kills the serverless
  // function (~30 s), which causes Paystack to treat the webhook as failed and retry
  // it — potentially processing the same event twice. 15 s is generous; Paystack
  // normally responds in <2 s.
  const signal = AbortSignal.timeout(15_000);

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await res.text();
  let json: PaystackResponse<T>;

  try {
    json = JSON.parse(text) as PaystackResponse<T>;
  } catch {
    throw new Error(`Paystack API error (${path}): invalid JSON response: ${text.slice(0, 200)}`);
  }

  if (!res.ok || !json.status) {
    throw new Error(`Paystack API error (${path}): ${json.message || res.statusText}`);
  }

  return json.data;
}

export async function initializeTransaction(payload: {
  email: string;
  amount: number;
  currency?: string;
  plan?: string;
  channels?: Array<'card' | 'bank' | 'ussd' | 'qr' | 'mobile_money' | 'bank_transfer'>;
  callback_url?: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackTransactionInit> {
  return paystackRequest<PaystackTransactionInit>('POST', '/transaction/initialize', payload as Record<string, unknown>);
}

export async function getOrCreatePaystackCustomer(
  prismaClient: any,
  userId: string,
  email: string,
  name?: string | null,
): Promise<string> {
  const user = await prismaClient.user.findUnique({
    where: { id: userId },
    select: { paystackCustomerCode: true },
  });

  if (user?.paystackCustomerCode) return user.paystackCustomerCode as string;

  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || undefined;
  const lastName = parts.slice(1).join(' ') || undefined;

  const customer = await paystackRequest<PaystackCustomer>('POST', '/customer', {
    email,
    first_name: firstName,
    last_name: lastName,
    metadata: { userId },
  });

  await prismaClient.user.update({
    where: { id: userId },
    data: { paystackCustomerCode: customer.customer_code },
  });

  return customer.customer_code;
}

export async function fetchPaystackSubscription(subscriptionCode: string): Promise<PaystackSubscription> {
  return paystackRequest<PaystackSubscription>('GET', `/subscription/${encodeURIComponent(subscriptionCode)}`);
}

export async function disablePaystackSubscription(code: string, emailToken: string): Promise<void> {
  await paystackRequest<unknown>('POST', '/subscription/disable', { code, token: emailToken });
}

export async function enablePaystackSubscription(code: string, emailToken: string): Promise<void> {
  await paystackRequest<unknown>('POST', '/subscription/enable', { code, token: emailToken });
}

export const disableSubscription = disablePaystackSubscription;
export const enableSubscription = enablePaystackSubscription;

/**
 * Creates a Paystack subscription via POST /subscription.
 *
 * ISSUE-11: Previously marked @deprecated with "never import into route or service files",
 * but subscription_service.ts legitimately imports and uses it in two places:
 *   1. applyPendingDowngradeIfDue — creates a new subscription on the lower plan.
 *   2. reactivateSubscription — creates a replacement when paystackEnable fails.
 *
 * NEVER call this from verifyPaystackPayment or any webhook handler.
 * When checkout passes a plan_code, Paystack creates the subscription automatically
 * and fires subscription.create. Calling this additionally creates a SECOND subscription
 * and causes a double-charge on the next billing cycle (was root cause of FIX-PS-1).
 */
export async function createPaystackSubscription(
  customerCode: string,
  planCode: string,
  authorizationCode?: string,
  startDate?: Date,
): Promise<PaystackSubscriptionCreate> {
  const body: Record<string, unknown> = {
    customer: customerCode,
    plan: planCode,
  };

  if (authorizationCode) body.authorization = authorizationCode;
  if (startDate) body.start_date = startDate.toISOString();

  return paystackRequest<PaystackSubscriptionCreate>('POST', '/subscription', body);
}

export async function findPaystackSubscriptionByCustomer(
  customerCode: string,
  planCode?: string | null,
): Promise<PaystackSubscriptionCreate | null> {
  const payload = await paystackRequest<any>('GET', `/subscription?customer=${encodeURIComponent(customerCode)}&perPage=50&page=1`);
  const list: any[] = Array.isArray(payload) ? payload : (payload?.data ?? []);

  if (!list.length) return null;

  const matches = list.filter(s => {
    const customerMatches = s?.customer?.customer_code === customerCode || s?.customer === customerCode;
    const planMatches = !planCode || s?.plan?.plan_code === planCode || s?.plan === planCode;
    const hasCodes = !!s?.subscription_code && !!s?.email_token;
    return customerMatches && planMatches && hasCodes;
  });

  const sorted = matches.sort((a, b) => {
    const aActive = a.status === 'active' ? 1 : 0;
    const bActive = b.status === 'active' ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
  });

  const s = sorted[0];
  if (!s) return null;

  return {
    subscription_code: s.subscription_code,
    email_token: s.email_token,
    status: s.status,
    next_payment_date: s.next_payment_date ?? null,
  };
}

async function createPaymentOnceForReference(params: {
  subscriptionId: string;
  reference: string;
  amountCents: number;
  currency: string;
  status: string;
  paidAt?: Date | null;
}) {
  const existing = await prisma.payment.findFirst({ where: { paystackReference: params.reference } });
  if (existing) return existing;

  return prisma.payment.create({
    data: {
      subscriptionId: params.subscriptionId,
      paystackReference: params.reference,
      amountCents: params.amountCents,
      currency: params.currency,
      status: params.status,
      paidAt: params.paidAt ?? null,
      provider: 'PAYSTACK',
    },
  }).catch(async (err: any) => {
    const existingAfterRace = await prisma.payment.findFirst({ where: { paystackReference: params.reference } });
    if (existingAfterRace) return existingAfterRace;
    throw err;
  });
}

async function storeCodesAndActivate(params: {
  subscriptionId: string;
  subscriptionCode: string;
  emailToken: string;
  reference?: string | null;
  nextPaymentDate?: Date | null;
  currentPeriodStart?: Date;
  previousStatus?: any;
}) {
  const now = params.currentPeriodStart ?? new Date();

  const existing = await prisma.subscription.findUnique({
    where: { id: params.subscriptionId },
    select: { id: true, status: true, interval: true, currentPeriodEnd: true },
  });

  if (!existing) throw new Error('Subscription row not found while storing Paystack codes');

  const periodEnd = params.nextPaymentDate
    ?? existing.currentPeriodEnd
    ?? addInterval(now, existing.interval as BillingInterval);

  await prisma.subscription.update({
    where: { id: params.subscriptionId },
    data: {
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      paystackSubscriptionCode: params.subscriptionCode,
      paystackEmailToken: params.emailToken,
      ...(params.reference ? { paystackReference: params.reference } : {}),
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      activatedAt: existing.status === 'ACTIVE' ? undefined : now,
      cancelAtPeriodEnd: false,
    },
  });
}

export async function verifyPaystackPayment(reference: string, userId: string): Promise<VerifyPaymentResult> {
  const txn = await paystackRequest<Record<string, any>>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

  if (txn.status !== 'success') {
    return {
      success: false,
      status: String(txn.status),
      message: `Payment status is "${txn.status}". Expected "success".`,
    };
  }

  const meta = (txn.metadata ?? {}) as Record<string, any>;
  const metaSubscriptionId = meta.subscriptionId as string | undefined;

  let sub = metaSubscriptionId
    ? await prisma.subscription.findFirst({
        where: { id: metaSubscriptionId, userId },
        include: { plan: true },
      })
    : null;

  if (!sub) {
    sub = await prisma.subscription.findFirst({
      where: { paystackReference: reference, userId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!sub) {
    return {
      success: false,
      status: 'not_found',
      message: 'No subscription found for this payment reference.',
    };
  }

  // FIX-3: Validate that the paid amount matches the plan's configured price.
  // Checking status === 'success' alone is insufficient defence — the amount must
  // also match so a mis-configured or manipulated transaction cannot activate a
  // higher-tier plan for a lower-tier price.
  const expectedAmountKobo =
    ((sub.interval ?? 'MONTHLY') === 'YEARLY'
      ? (sub.plan as any)?.mpesaYearlyKes
      : (sub.plan as any)?.mpesaMonthlyKes) * 100;

  // ISSUE-10: Apply same 5% tolerance as webhook handler (rounding/FX edge cases).
  // Also guard against NaN when plan is null (undefined * 100 = NaN; NaN > 0 = false
  // which would silently skip the check — explicit isNaN guard makes intent clear).
  if (expectedAmountKobo > 0 && !isNaN(expectedAmountKobo) && Number(txn.amount) < expectedAmountKobo * 0.95) {
    return {
      success: false,
      status: 'amount_mismatch',
      message:
        `Payment amount ${txn.amount} kobo is below the required ` +
        `${expectedAmountKobo} kobo (with 5% tolerance) for this plan.`,
    };
  }

  // If the authoritative webhook or fetch-codes route already completed activation,
  // verification must be read-only. Never downgrade ACTIVE rows back to INCOMPLETE.
  if (sub.status === 'ACTIVE' && sub.paystackSubscriptionCode && sub.paystackEmailToken) {
    await createPaymentOnceForReference({
      subscriptionId: sub.id,
      reference,
      amountCents: Number(txn.amount ?? 0),
      currency: String(txn.currency ?? 'KES').toUpperCase(),
      status: 'succeeded',
      paidAt: new Date(),
    });

    return {
      success: true,
      status: 'success',
      subscription: await fetchCurrentSub(userId),
      message: 'Payment already verified and subscription is active.',
    };
  }

  const now = new Date();
  const interval = (sub.interval ?? 'MONTHLY') as BillingInterval;
  const planCode = interval === 'YEARLY'
    ? (sub.plan as any)?.paystackPlanCodeYearly
    : (sub.plan as any)?.paystackPlanCodeMonthly;

  const nextPaymentDate = txn.subscription?.next_payment_date
    ? new Date(txn.subscription.next_payment_date as string)
    : addInterval(now, interval);

  const customerCode = txn.customer?.customer_code ?? sub.paystackCustomerCode ?? meta.customerCode ?? null;

  if (customerCode && customerCode !== sub.paystackCustomerCode) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { paystackCustomerCode: customerCode },
    });
  }

  await createPaymentOnceForReference({
    subscriptionId: sub.id,
    reference,
    amountCents: Number(txn.amount ?? 0),
    currency: String(txn.currency ?? 'KES').toUpperCase(),
    status: 'succeeded',
    paidAt: now,
  });

  // Check if codes are already on the txn verify response
  let subscriptionCode = pickSubscriptionCode(txn);
  let emailToken = pickEmailToken(txn);

  // FIX-PS-1: Only attempt a read-only lookup — never POST /subscription here.
  // When checkout passes a plan_code, Paystack creates the subscription itself
  // and fires subscription.create. Calling POST /subscription would create a
  // duplicate and cause a double-charge on the next billing cycle. If codes are
  // not on the verify response yet, look them up passively; if they're not ready,
  // return pending and let the webhook be authoritative.
  if ((!subscriptionCode || !emailToken) && customerCode) {
    const found = await findPaystackSubscriptionByCustomer(customerCode, planCode).catch(() => null);
    if (found?.subscription_code && found?.email_token) {
      subscriptionCode = found.subscription_code;
      emailToken = found.email_token;
    }
  }

  if (subscriptionCode && emailToken) {
    await storeCodesAndActivate({
      subscriptionId: sub.id,
      subscriptionCode,
      emailToken,
      reference,
      nextPaymentDate,
      currentPeriodStart: sub.currentPeriodStart ?? now,
      previousStatus: sub.status,
    });

    await prisma.subscriptionLog.create({
      data: {
        subscriptionId: sub.id,
        event: sub.status === 'ACTIVE' ? 'PAYMENT_SUCCEEDED' : 'ACTIVATED',
        previousStatus: sub.status,
        newStatus: 'ACTIVE',
        metadata: {
          paystackReference: reference,
          paystackSubscriptionCode: subscriptionCode,
          source: 'client_verify',
        },
      },
    }).catch(() => undefined);

    return { success: true, status: 'success', subscription: await fetchCurrentSub(userId) };
  }

  // Payment is real, but Paystack subscription codes are not ready yet.
  // Keep the existing status; do not activate and do not downgrade a row
  // that another path already fixed. The subscription.create webhook will
  // complete activation when Paystack emits it (typically within seconds).
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      provider: 'PAYSTACK',
      paystackReference: reference,
      paystackCustomerCode: customerCode ?? sub.paystackCustomerCode,
      currentPeriodStart: sub.currentPeriodStart ?? now,
      currentPeriodEnd: sub.currentPeriodEnd ?? nextPaymentDate,
      cancelAtPeriodEnd: false,
    },
  });

  await prisma.subscriptionLog.create({
    data: {
      subscriptionId: sub.id,
      event: 'PAYMENT_SUCCEEDED',
      previousStatus: sub.status,
      newStatus: sub.status,
      metadata: {
        paystackReference: reference,
        source: 'client_verify_pending_codes',
        reason: 'subscription_code/email_token not yet available — awaiting subscription.create webhook',
      },
    },
  }).catch(() => undefined);

  return {
    success: true,
    status: 'pending_subscription_codes',
    pending: true,
    subscription: await fetchCurrentSub(userId),
    message: 'Payment verified. Waiting for Paystack subscription.create webhook to store subscription codes.',
  };
}

async function fetchCurrentSub(userId: string): Promise<CurrentSubscription | null> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      // FIX-RECONCILE-2: Include INCOMPLETE so that a pending-activation row is
      // returned in verifyPaystackPayment and reconcilePaystackSubscriptionCodesForUser
      // responses.  Previously INCOMPLETE was excluded, so both functions returned
      // subscription:null while the payment was processing — the frontend had nothing
      // to show and the verify route's 202 response carried no subscription data.
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD', 'INCOMPLETE'] },
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) return null;

  const interval: BillingInterval = sub.interval ?? 'MONTHLY';
  const hasPaystackCodes = !!(sub.paystackSubscriptionCode && sub.paystackEmailToken);
  const isPendingActivation = sub.provider === 'PAYSTACK' && (sub.status === 'INCOMPLETE' || !hasPaystackCodes);

  return {
    id: sub.id,
    status: sub.status,
    interval,
    plan: {
      id: sub.plan?.id ?? '',
      slug: (sub.plan?.slug ?? 'pro') as PlanSlug,
      name: sub.plan?.name ?? 'Pro',
      description: (sub.plan as any)?.description ?? null,
      monthlyPriceCents: (sub.plan as any)?.monthlyPriceCents ?? 0,
      yearlyPriceCents: (sub.plan as any)?.yearlyPriceCents ?? 0,
      trialDays: (sub.plan as any)?.trialDays ?? 0,
      maxWorkoutsPerMonth: (sub.plan as any)?.maxWorkoutsPerMonth ?? null,
      maxPrograms: (sub.plan as any)?.maxPrograms ?? null,
      hasAdvancedAnalytics: (sub.plan as any)?.hasAdvancedAnalytics ?? false,
      hasPersonalCoaching: (sub.plan as any)?.hasPersonalCoaching ?? false,
      hasNutritionTracking: (sub.plan as any)?.hasNutritionTracking ?? false,
      hasOfflineAccess: (sub.plan as any)?.hasOfflineAccess ?? false,
      features: Array.isArray((sub.plan as any)?.features) ? (sub.plan as any).features : [],
      displayOrder: (sub.plan as any)?.displayOrder ?? 0,
      isPopular: (sub.plan as any)?.isPopular ?? false,
    },
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
    cancelledAt: sub.cancelledAt?.toISOString() ?? null,
    scheduledPlanSlug: null,
    activatedAt: sub.activatedAt?.toISOString() ?? null,
    daysUntilRenewal: sub.currentPeriodEnd
      ? Math.max(0, Math.ceil((sub.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
      : null,
    paystackSubscriptionCode: null, // ISSUE-2: real code never sent to client (security fix — see getCurrentSubscription)
    hasPaystackCodes,
    isPendingActivation,
  };
}

export async function generatePaystackManageLink(subscriptionCode: string): Promise<string> {
  const data = await paystackRequest<{ link: string }>(
    'GET',
    `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link/`,
  );
  return data.link;
}

export async function sendPaystackManageEmail(subscriptionCode: string): Promise<void> {
  await paystackRequest<unknown>(
    'POST',
    `/subscription/${encodeURIComponent(subscriptionCode)}/manage/email/`,
  );
}

export function verifyPaystackWebhook(rawBody: Buffer | string, signature: string): PaystackWebhookEvent {
  // Paystack signs webhook payloads with the integration SECRET KEY.
  // Do not use a separate PAYSTACK_WEBHOOK_SECRET; if that env var differs
  // from PAYSTACK_SECRET_KEY, every real Paystack webhook fails verification
  // and subscription.create never stores subscription_code/email_token.
  const secret = SECRET_KEY;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  const expected = crypto.createHmac('sha512', secret).update(body).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  const valid =
    expectedBuffer.length === signatureBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  if (!valid) throw new Error('Invalid Paystack webhook signature');

  return JSON.parse(body) as PaystackWebhookEvent;
}


export interface PaystackReconcileResult {
  checked: number;
  activated: number;
  stillPending: number;
  errors: number;
  subscription?: CurrentSubscription | null;
  message: string;
}

async function activatePendingPaystackSubscriptionFromCodes(params: {
  subscriptionId: string;
  subscriptionCode: string;
  emailToken: string;
  reference?: string | null;
  nextPaymentDate?: Date | null;
  source: string;
}): Promise<void> {
  const now = new Date();
  const sub = await prisma.subscription.findUnique({
    where: { id: params.subscriptionId },
    select: {
      id: true,
      status: true,
      interval: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      activatedAt: true,
    },
  });

  if (!sub) throw new Error('Subscription row not found during Paystack reconciliation');

  const currentPeriodEnd = params.nextPaymentDate
    ?? sub.currentPeriodEnd
    ?? addInterval(now, sub.interval as BillingInterval);

  await prisma.subscription.update({
    where: { id: params.subscriptionId },
    data: {
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      paystackSubscriptionCode: params.subscriptionCode,
      paystackEmailToken: params.emailToken,
      ...(params.reference ? { paystackReference: params.reference } : {}),
      currentPeriodStart: sub.currentPeriodStart ?? now,
      currentPeriodEnd,
      activatedAt: sub.activatedAt ?? now,
      cancelAtPeriodEnd: false,
      autoRenew: true,
    },
  });

  await prisma.subscriptionLog.create({
    data: {
      subscriptionId: params.subscriptionId,
      event: sub.status === 'ACTIVE' ? 'PAYMENT_SUCCEEDED' : 'ACTIVATED',
      previousStatus: sub.status as any,
      newStatus: 'ACTIVE',
      metadata: {
        source: params.source,
        paystackReference: params.reference ?? null,
        paystackSubscriptionCode: params.subscriptionCode,
        hasEmailToken: true,
      } as any,
    },
  }).catch(() => undefined);
}

/**
 * Reconciles Paystack subscriptions after payment success.
 * This is the mandatory backend fallback for Paystack's delayed subscription.create event:
 * payment can succeed before subscription_code/email_token are visible.
 */
export async function reconcilePaystackSubscriptionCodesForUser(
  userId: string,
  reference?: string | null,
): Promise<PaystackReconcileResult> {
  const candidates = await prisma.subscription.findMany({
    where: {
      userId,
      provider: 'PAYSTACK',
      // FIX-RECONCILE-1: Exclude terminal statuses.
      // Without this guard the OR conditions below matched CANCELLED/EXPIRED rows
      // (all have null codes).  findPaystackSubscriptionByCustomer then returned the
      // live subscription's codes and activatePendingPaystackSubscriptionFromCodes
      // wrote those codes into the dead rows, leaving the actual INCOMPLETE row
      // untouched and creating duplicate ACTIVE rows in the database.
      status: { notIn: ['CANCELLED', 'EXPIRED', 'INCOMPLETE_EXPIRED'] },
      OR: [
        { status: 'INCOMPLETE' },
        { paystackSubscriptionCode: null },
        { paystackEmailToken: null },
        ...(reference ? [{ paystackReference: reference }] : []),
      ],
    },
    include: { plan: true },
    orderBy: { updatedAt: 'desc' },
    take: 5,
  });

  let checked = 0;
  let activated = 0;
  let stillPending = 0;
  let errors = 0;

  for (const sub of candidates) {
    checked++;

    if (sub.status === 'ACTIVE' && sub.paystackSubscriptionCode && sub.paystackEmailToken) {
      continue;
    }

    if (!sub.paystackCustomerCode) {
      stillPending++;
      continue;
    }

    const planCode = sub.interval === 'YEARLY'
      ? (sub.plan as any)?.paystackPlanCodeYearly
      : (sub.plan as any)?.paystackPlanCodeMonthly;

    try {
      const found = await findPaystackSubscriptionByCustomer(sub.paystackCustomerCode, planCode);

      if (!found?.subscription_code || !found?.email_token) {
        stillPending++;
        continue;
      }

      await activatePendingPaystackSubscriptionFromCodes({
        subscriptionId: sub.id,
        subscriptionCode: found.subscription_code,
        emailToken: found.email_token,
        reference: reference ?? sub.paystackReference,
        nextPaymentDate: found.next_payment_date ? new Date(found.next_payment_date) : null,
        source: 'backend_reconciliation',
      });

      activated++;
    } catch (err) {
      console.error('[paystack reconcile user] failed:', err);
      errors++;
    }
  }

  const subscription = await fetchCurrentSub(userId);

  return {
    checked,
    activated,
    stillPending,
    errors,
    subscription,
    message: activated > 0
      ? 'Paystack subscription codes stored and subscription activated.'
      : 'Paystack subscription codes are still not available. Waiting for subscription.create webhook or next reconciliation run.',
  };
}

export async function reconcilePendingPaystackSubscriptions(limit = 25): Promise<PaystackReconcileResult> {
  const candidates = await prisma.subscription.findMany({
    where: {
      provider: 'PAYSTACK',
      status: 'INCOMPLETE',
      paystackCustomerCode: { not: null },
    },
    include: { plan: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  let checked = 0;
  let activated = 0;
  let stillPending = 0;
  let errors = 0;

  for (const sub of candidates) {
    checked++;
    const planCode = sub.interval === 'YEARLY'
      ? (sub.plan as any)?.paystackPlanCodeYearly
      : (sub.plan as any)?.paystackPlanCodeMonthly;

    try {
      const found = await findPaystackSubscriptionByCustomer(sub.paystackCustomerCode!, planCode);
      if (!found?.subscription_code || !found?.email_token) {
        stillPending++;
        continue;
      }

      await activatePendingPaystackSubscriptionFromCodes({
        subscriptionId: sub.id,
        subscriptionCode: found.subscription_code,
        emailToken: found.email_token,
        reference: sub.paystackReference,
        nextPaymentDate: found.next_payment_date ? new Date(found.next_payment_date) : null,
        source: 'scheduled_backend_reconciliation',
      });
      activated++;
    } catch (err) {
      console.error('[paystack reconcile pending] failed:', err);
      errors++
    }
  }

  return {
    checked,
    activated,
    stillPending,
    errors,
    subscription: null,
    message: `Paystack reconciliation complete: checked=${checked}, activated=${activated}, stillPending=${stillPending}, errors=${errors}.`,
  };
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
  findPaystackSubscriptionByCustomer,
  generatePaystackManageLink,
  sendPaystackManageEmail,
  verifyPaystackPayment,
  reconcilePaystackSubscriptionCodesForUser,
  reconcilePendingPaystackSubscriptions,
  verifyPaystackWebhook,
};
