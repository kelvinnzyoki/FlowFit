/**
 * FLOWFIT — Paystack Service (FINAL CORRECTED)
 *
 * Core rules:
 * 1. Checkout MUST pass a Paystack plan_code to /transaction/initialize.
 * 2. A Paystack subscription is not considered usable until BOTH
 *    subscription_code and email_token are stored.
 * 3. Client verification must not mark the DB subscription ACTIVE unless
 *    those two management codes are present.
 * 4. subscription.create webhook is the authoritative fallback for storing codes.
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
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
      message: 'No pending subscription found for this payment reference.',
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

  await prisma.payment.upsert({
    where: { id: `paystack_${reference}` },
    update: {
      status: 'succeeded',
      paidAt: now,
      amountCents: Number(txn.amount ?? 0),
      currency: String(txn.currency ?? 'KES').toUpperCase(),
    },
    create: {
      id: `paystack_${reference}`,
      subscriptionId: sub.id,
      paystackReference: reference,
      amountCents: Number(txn.amount ?? 0),
      currency: String(txn.currency ?? 'KES').toUpperCase(),
      status: 'succeeded',
      paidAt: now,
      provider: 'PAYSTACK',
    },
  }).catch(async () => {
    const existing = await prisma.payment.findFirst({ where: { paystackReference: reference } });
    if (!existing) {
      await prisma.payment.create({
        data: {
          subscriptionId: sub!.id,
          paystackReference: reference,
          amountCents: Number(txn.amount ?? 0),
          currency: String(txn.currency ?? 'KES').toUpperCase(),
          status: 'succeeded',
          paidAt: now,
          provider: 'PAYSTACK',
        },
      });
    }
  });

  let subscriptionCode = pickSubscriptionCode(txn);
  let emailToken = pickEmailToken(txn);

  if ((!subscriptionCode || !emailToken) && customerCode) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const found = await findPaystackSubscriptionByCustomer(customerCode, planCode).catch(() => null);
      if (found?.subscription_code && found?.email_token) {
        subscriptionCode = found.subscription_code;
        emailToken = found.email_token;
        break;
      }
      if (attempt < 4) await sleep(1500);
    }
  }

  if (subscriptionCode && emailToken) {
    await storeCodesAndActivate({
      subscriptionId: sub.id,
      subscriptionCode,
      emailToken,
      reference,
      nextPaymentDate,
      currentPeriodStart: now,
      previousStatus: sub.status,
    });

    await prisma.subscriptionLog.create({
      data: {
        subscriptionId: sub.id,
        event: 'ACTIVATED',
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

  // Payment is real, but management codes are not ready yet. Do NOT activate.
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'INCOMPLETE',
      provider: 'PAYSTACK',
      paystackReference: reference,
      paystackCustomerCode: customerCode ?? sub.paystackCustomerCode,
      currentPeriodStart: now,
      currentPeriodEnd: nextPaymentDate,
      cancelAtPeriodEnd: false,
    },
  });

  await prisma.subscriptionLog.create({
    data: {
      subscriptionId: sub.id,
      event: 'PAYMENT_SUCCEEDED',
      previousStatus: sub.status,
      newStatus: 'INCOMPLETE',
      metadata: {
        paystackReference: reference,
        source: 'client_verify_pending_codes',
        reason: 'subscription_code/email_token not yet available',
      },
    },
  }).catch(() => undefined);

  return {
    success: true,
    status: 'pending_subscription_codes',
    pending: true,
    subscription: await fetchCurrentSub(userId),
    message: 'Payment verified. Waiting for Paystack subscription.create webhook to provide subscription_code and email_token.',
  };
}

async function fetchCurrentSub(userId: string): Promise<CurrentSubscription | null> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD'] },
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) return null;

  const interval: BillingInterval = sub.interval ?? 'MONTHLY';

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
    paystackSubscriptionCode: sub.paystackSubscriptionCode ?? null,
    paystackEmailToken: sub.paystackEmailToken ?? null,
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
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET ?? SECRET_KEY;
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

export default {
  paystackRequest,
  initializeTransaction,
  getOrCreatePaystackCustomer,
  fetchPaystackSubscription,
  disablePaystackSubscription,
  enablePaystackSubscription,
  disableSubscription,
  enableSubscription,
  createPaystackSubscription,
  findPaystackSubscriptionByCustomer,
  generatePaystackManageLink,
  sendPaystackManageEmail,
  verifyPaystackPayment,
  verifyPaystackWebhook,
};
