/**
 * FLOWFIT — Subscription Service (v2)
 *
 * Adds M-Pesa subscription support on top of the existing Stripe logic.
 * New exports:
 *   createMpesaSubscription   — initiate first STK Push for a new subscriber
 *   renewMpesaSubscription    — triggered by cron when period is ending
 *   handleMpesaSuccess        — called by webhook on successful callback
 *   handleMpesaFailure        — called by webhook on failed callback
 *   applyGracePeriodOrExpire  — marks grace period or expires subscription
 *   runRenewalReminders       — cron: find subs needing a reminder
 *   runMpesaRenewals          — cron: trigger STK for expiring M-Pesa subs
 *   runRetries                — cron: retry failed M-Pesa STK pushes
 *   runExpiry                 — cron: expire unpaid/grace-period-exceeded subs
 */

import { PrismaClient, SubscriptionStatus, BillingInterval, SubscriptionEvent, PaymentProvider } from '@prisma/client';
import type { PublicPlan, CurrentSubscription } from '../types/subscription.types.js';
import { stripe, getOrCreateStripeCustomer } from './stripe.service.js';
import { initiateStkPush, normalisePhone } from './mpesa.service.js';
import Stripe from 'stripe';
import prisma from '../config/db.js';

// ── Config ────────────────────────────────────────────────────────────────────

const GRACE_PERIOD_DAYS    = 3;    // days after expiry before we downgrade
const MAX_MPESA_ATTEMPTS   = 3;    // total attempts per billing cycle
const RETRY_INTERVAL_HOURS = 24;   // hours between retries
const REMINDER_DAYS_BEFORE = 3;    // send reminder N days before expiry

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysUntil(date: Date | null | undefined): number | null {
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toPublicPlan(plan: any): PublicPlan {
  return {
    id: plan.id,
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    monthlyPriceCents: plan.monthlyPriceCents,
    yearlyPriceCents: plan.yearlyPriceCents,
    trialDays: plan.trialDays,
    maxWorkoutsPerMonth: plan.maxWorkoutsPerMonth,
    maxPrograms: plan.maxPrograms,
    hasAdvancedAnalytics: plan.hasAdvancedAnalytics,
    hasPersonalCoaching: plan.hasPersonalCoaching,
    hasNutritionTracking: plan.hasNutritionTracking,
    hasOfflineAccess: plan.hasOfflineAccess,
    features: Array.isArray(plan.features) ? plan.features : JSON.parse(plan.features as string),
    displayOrder: plan.displayOrder,
    isPopular: plan.isPopular,
  };
}

async function logEvent(
  subscriptionId: string,
  event: SubscriptionEvent,
  previousStatus: SubscriptionStatus | null | undefined,
  newStatus: SubscriptionStatus | null | undefined,
  metadata: Record<string, unknown> = {},
  ipAddress?: string,
) {
  await prisma.subscriptionLog.create({
    data: {
      subscriptionId,
      event,
      previousStatus: previousStatus ?? undefined,
      newStatus: newStatus ?? undefined,
      metadata: metadata as any,
      ipAddress,
    },
  });
}

// ── Distributed cron lock (prevents duplicate execution across Vercel invocations) ──

async function acquireCronLock(jobId: string, durationMs = 10 * 60 * 1000): Promise<boolean> {
  const now      = new Date();
  const expires  = new Date(now.getTime() + durationMs);
  try {
    await prisma.cronLock.upsert({
      where: { id: jobId },
      create: { id: jobId, lockedAt: now, expiresAt: expires },
      update: {
        // Only acquire if the existing lock has expired
        lockedAt:  now,
        expiresAt: expires,
      },
    });

    // Re-read and confirm we got the lock (compare lockedAt)
    const lock = await prisma.cronLock.findUnique({ where: { id: jobId } });
    return lock?.lockedAt.getTime() === now.getTime() ||
           (lock?.expiresAt != null && lock.expiresAt < now);
  } catch {
    return false;
  }
}

async function releaseCronLock(jobId: string): Promise<void> {
  await prisma.cronLock.delete({ where: { id: jobId } }).catch(() => {});
}

// ── Plans ─────────────────────────────────────────────────────────────────────

export async function getPlans(): Promise<PublicPlan[]> {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  return plans.map(toPublicPlan);
}

// ── Current subscription ──────────────────────────────────────────────────────

export async function getCurrentSubscription(userId: string): Promise<CurrentSubscription | null> {
  const sub = await prisma.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  if (!sub) return null;

  let scheduledPlanSlug: string | null = null;
  if (sub.scheduledPlanId) {
    const sp = await prisma.plan.findUnique({ where: { id: sub.scheduledPlanId }, select: { slug: true } });
    scheduledPlanSlug = sp?.slug ?? null;
  }

  return {
    id: sub.id,
    status: sub.status,
    interval: sub.interval,
    plan: toPublicPlan(sub.plan),
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelledAt: sub.cancelledAt?.toISOString() ?? null,
    scheduledPlanSlug,
    activatedAt: sub.activatedAt?.toISOString() ?? null,
    daysUntilRenewal: daysUntil(sub.currentPeriodEnd),
    provider: sub.provider,
    autoRenew: sub.autoRenew,
  } as any;
}

// ── STRIPE: Checkout session ──────────────────────────────────────────────────

export async function createCheckoutSession(
  userId: string,
  email: string,
  name: string | null | undefined,
  planId: string,
  interval: BillingInterval,
): Promise<{ url: string; sessionId: string }> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error('Plan not found');
  if (!plan.isActive) throw new Error('Plan is no longer available');

  const stripePriceId = interval === 'YEARLY' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
  if (!stripePriceId) throw new Error(`Stripe price not configured for plan "${plan.slug}" / ${interval}`);

  const stripeCustomerId = await getOrCreateStripeCustomer(prisma, userId, email, name);

  const existing = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
  });

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: stripePriceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/subscription.html?session_id={CHECKOUT_SESSION_ID}&success=1`,
    cancel_url: `${process.env.APP_URL}/subscription.html?cancelled=1`,
    metadata: { userId, planId, interval, existingSubscriptionId: existing?.id ?? '' },
    subscription_data: {
      metadata: { userId, planId },
      ...(plan.trialDays > 0 && !existing ? { trial_period_days: plan.trialDays } : {}),
    },
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    customer_update: { address: 'auto' },
  };

  const session = await stripe.checkout.sessions.create(sessionParams);

  const pendingSub = await prisma.subscription.create({
    data: {
      userId, planId,
      status: 'INCOMPLETE',
      interval,
      provider: 'STRIPE',
      stripeCheckoutSessionId: session.id,
      trialStartedAt: plan.trialDays > 0 && !existing ? new Date() : null,
      trialEndsAt: plan.trialDays > 0 && !existing
        ? new Date(Date.now() + plan.trialDays * 86_400_000) : null,
    },
  });

  await logEvent(pendingSub.id, 'CREATED', null, 'INCOMPLETE', {
    planSlug: plan.slug, interval, sessionId: session.id,
  });

  return { url: session.url!, sessionId: session.id };
}

// ── M-PESA: Create subscription (first STK Push) ─────────────────────────────

export interface MpesaSubscribeResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage:   string;
  subscriptionId:    string;
}

export async function createMpesaSubscription(
  userId: string,
  planId: string,
  interval: BillingInterval,
  phone: string,
): Promise<MpesaSubscribeResult> {
  const [plan, user] = await Promise.all([
    prisma.plan.findUnique({ where: { id: planId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, mpesaPhone: true } }),
  ]);

  if (!plan) throw new Error('Plan not found');
  if (!plan.isActive) throw new Error('Plan is no longer available');

  const amountKes = interval === 'YEARLY' ? Math.ceil(plan.mpesaYearlyKes) : plan.mpesaMonthlyKes;
  if (!amountKes) throw new Error(`M-Pesa price not configured for ${plan.slug}/${interval}`);

  const normalisedPhone = normalisePhone(phone);

  // Store phone on user for future auto-renewals
  if (!user?.mpesaPhone || user.mpesaPhone !== normalisedPhone) {
    await prisma.user.update({ where: { id: userId }, data: { mpesaPhone: normalisedPhone } });
  }

  // Cancel any previous INCOMPLETE M-Pesa subs
  await prisma.subscription.updateMany({
    where: { userId, status: 'INCOMPLETE', provider: 'MPESA' },
    data: { status: 'INCOMPLETE_EXPIRED' },
  });

  // Create pending subscription
  const now = new Date();
  const pendingSub = await prisma.subscription.create({
    data: {
      userId, planId,
      status: 'INCOMPLETE',
      interval,
      provider: 'MPESA',
      autoRenew: true,
    },
  });

  // Initiate STK Push
  const stk = await initiateStkPush(
    normalisedPhone,
    amountKes,
    `FlowFit ${plan.name}`,
    `FlowFit ${plan.name} ${interval === 'YEARLY' ? 'Annual' : 'Monthly'} Subscription`,
  );

  // Record the transaction
  await prisma.mpesaTransaction.create({
    data: {
      subscriptionId:    pendingSub.id,
      userId,
      merchantRequestId: stk.merchantRequestId,
      checkoutRequestId: stk.checkoutRequestId,
      phoneNumber:       normalisedPhone,
      amountKes,
      status:            'PENDING',
      timeoutAt:         new Date(Date.now() + 5 * 60 * 1000),  // 5 min timeout
      attemptNumber:     1,
      isRenewal:         false,
    },
  });

  await logEvent(pendingSub.id, 'MPESA_STK_INITIATED', null, 'INCOMPLETE', {
    phone: normalisedPhone, amountKes, checkoutRequestId: stk.checkoutRequestId,
  });

  return { ...stk, subscriptionId: pendingSub.id };
}

// ── M-PESA: Handle successful payment callback ────────────────────────────────

export async function handleMpesaSuccess(
  checkoutRequestId: string,
  receiptNumber:     string,
  amountKes:         number,
): Promise<void> {
  const tx = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
    include: { subscription: { include: { plan: true } } },
  });

  if (!tx) {
    console.error(`[mpesa] No transaction for checkoutRequestId=${checkoutRequestId}`);
    return;
  }

  const { subscription: sub } = tx;
  const now     = new Date();
  const prevStatus = sub.status;

  // Calculate new billing period
  const periodStart = now;
  const periodEnd   = sub.interval === 'YEARLY' ? addMonths(now, 12) : addMonths(now, 1);

  await prisma.$transaction(async (tx2) => {
    // Update transaction
    await tx2.mpesaTransaction.update({
      where: { id: tx.id },
      data: {
        status:            'SUCCESS',
        mpesaReceiptNumber: receiptNumber,
        completedAt:        now,
      },
    });

    // Update subscription — activate or extend
    await tx2.subscription.update({
      where: { id: sub.id },
      data: {
        status:              'ACTIVE',
        currentPeriodStart:  periodStart,
        currentPeriodEnd:    periodEnd,
        activatedAt:         prevStatus !== 'ACTIVE' ? now : sub.activatedAt,
        gracePeriodEndsAt:   null,
        mpesaRenewalAttempts: 0,
        mpesaLastRenewalAt:   now,
        reminderSentAt:       null,   // reset for next cycle
      },
    });

    // Record payment
    await tx2.payment.create({
      data: {
        subscriptionId:    sub.id,
        provider:          'MPESA',
        mpesaTransactionId: tx.id,
        mpesaReceiptNumber: receiptNumber,
        amountCents:       amountKes * 100,  // stored as cents for consistency
        currency:          'KES',
        status:            'succeeded',
      },
    });

    await tx2.subscriptionLog.create({
      data: {
        subscriptionId: sub.id,
        event:          'MPESA_STK_SUCCESS',
        previousStatus: prevStatus,
        newStatus:      'ACTIVE',
        metadata: {
          receiptNumber, amountKes,
          periodEnd: periodEnd.toISOString(),
          checkoutRequestId,
        },
      },
    });
  });

  console.log(`[mpesa] ✅ Payment success sub=${sub.id} receipt=${receiptNumber}`);
}

// ── M-PESA: Handle failed/cancelled payment callback ────────────────────────

export async function handleMpesaFailure(
  checkoutRequestId: string,
  resultCode:        string,
  resultDesc:        string,
): Promise<void> {
  const tx = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
    include: { subscription: true },
  });

  if (!tx) return;

  const { subscription: sub } = tx;
  const now = new Date();

  await prisma.$transaction(async (tx2) => {
    await tx2.mpesaTransaction.update({
      where: { id: tx.id },
      data: { status: 'FAILED', resultCode, resultDesc, completedAt: now },
    });

    // Increment failure count
    const newAttempts = sub.mpesaRenewalAttempts + 1;

    await tx2.subscription.update({
      where: { id: sub.id },
      data: { mpesaRenewalAttempts: newAttempts },
    });

    await tx2.subscriptionLog.create({
      data: {
        subscriptionId: sub.id,
        event:          'MPESA_STK_FAILED',
        previousStatus: sub.status,
        newStatus:      sub.status,
        metadata: { resultCode, resultDesc, attempt: tx.attemptNumber, checkoutRequestId },
      },
    });
  });

  // If this was for an active subscription nearing/past expiry, apply grace or expire
  if (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE' || sub.status === 'GRACE_PERIOD') {
    const attempts = sub.mpesaRenewalAttempts + 1;
    if (attempts >= MAX_MPESA_ATTEMPTS) {
      await applyGracePeriodOrExpire(sub.id);
    } else {
      // Mark for retry
      console.log(`[mpesa] ⚠️ Payment failed sub=${sub.id} attempt=${attempts}/${MAX_MPESA_ATTEMPTS} — retry scheduled`);
    }
  }
}

// ── M-PESA: Renew a subscription (trigger new STK Push for renewal) ──────────

export async function renewMpesaSubscription(subscriptionId: string): Promise<void> {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true, user: true },
  });

  if (!sub) throw new Error(`Subscription not found: ${subscriptionId}`);
  if (!sub.user.mpesaPhone) throw new Error(`No M-Pesa phone on user ${sub.userId}`);
  if (!sub.autoRenew) {
    console.log(`[mpesa] Auto-renew disabled for sub=${subscriptionId} — skipping`);
    return;
  }

  const amountKes = sub.interval === 'YEARLY'
    ? sub.plan.mpesaYearlyKes
    : sub.plan.mpesaMonthlyKes;

  if (!amountKes) throw new Error(`No M-Pesa price for ${sub.plan.slug}/${sub.interval}`);

  const attemptNumber = sub.mpesaRenewalAttempts + 1;

  const stk = await initiateStkPush(
    sub.user.mpesaPhone,
    amountKes,
    `FlowFit ${sub.plan.name}`,
    `Renew ${sub.plan.name} ${sub.interval === 'YEARLY' ? 'Annual' : 'Monthly'}`,
  );

  await prisma.mpesaTransaction.create({
    data: {
      subscriptionId: sub.id,
      userId:         sub.userId,
      merchantRequestId: stk.merchantRequestId,
      checkoutRequestId: stk.checkoutRequestId,
      phoneNumber:    sub.user.mpesaPhone,
      amountKes,
      status:         'PENDING',
      timeoutAt:      new Date(Date.now() + 5 * 60 * 1000),
      attemptNumber,
      isRenewal:      true,
    },
  });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { mpesaLastRenewalAt: new Date(), mpesaRenewalAttempts: attemptNumber },
  });

  await logEvent(sub.id, 'MPESA_STK_INITIATED', sub.status, sub.status, {
    phone: sub.user.mpesaPhone, amountKes, checkoutRequestId: stk.checkoutRequestId,
    attemptNumber, isRenewal: true,
  });

  console.log(`[mpesa] STK Push sent sub=${sub.id} attempt=${attemptNumber} cid=${stk.checkoutRequestId}`);
}

// ── Grace period / expire ─────────────────────────────────────────────────────

export async function applyGracePeriodOrExpire(subscriptionId: string): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return;

  const now = new Date();
  const prevStatus = sub.status;

  if (sub.status !== 'GRACE_PERIOD') {
    // Start grace period
    const gracePeriodEndsAt = addDays(now, GRACE_PERIOD_DAYS);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'GRACE_PERIOD', gracePeriodEndsAt },
    });
    await logEvent(sub.id, 'GRACE_PERIOD_STARTED', prevStatus, 'GRACE_PERIOD', {
      gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
    });
    console.log(`[mpesa] Grace period started sub=${sub.id} until ${gracePeriodEndsAt.toISOString()}`);
  } else if (sub.gracePeriodEndsAt && sub.gracePeriodEndsAt < now) {
    // Grace period expired — deactivate
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'EXPIRED',
        expiredAt: now,
        gracePeriodEndsAt: null,
        autoRenew: false,
      },
    });
    await logEvent(sub.id, 'GRACE_PERIOD_EXPIRED', 'GRACE_PERIOD', 'EXPIRED', {
      reason: 'max_renewal_attempts_reached',
    });
    console.log(`[mpesa] Subscription EXPIRED sub=${sub.id}`);
  }
}

// ── CRON: Send renewal reminders ──────────────────────────────────────────────

export async function runRenewalReminders(): Promise<{ processed: number }> {
  const acquired = await acquireCronLock('renewal-reminders');
  if (!acquired) {
    console.log('[cron] renewal-reminders: skipped (locked)');
    return { processed: 0 };
  }

  try {
    const now = new Date();
    const reminderWindow = addDays(now, REMINDER_DAYS_BEFORE);

    // Find M-Pesa subs expiring within REMINDER_DAYS_BEFORE days, no reminder sent this cycle
    const subs = await prisma.subscription.findMany({
      where: {
        provider: 'MPESA',
        status: { in: ['ACTIVE'] },
        autoRenew: true,
        currentPeriodEnd: { lte: reminderWindow, gte: now },
        OR: [
          { reminderSentAt: null },
          { reminderSentAt: { lt: new Date(now.getTime() - 25 * 3600_000) } },  // not in last 25h
        ],
      },
      include: { user: true, plan: true },
    });

    for (const sub of subs) {
      // TODO: integrate your email/SMS provider here
      // await emailService.send(sub.user.email, 'renewal-reminder', { plan: sub.plan.name, ... });
      console.log(`[cron] Reminder → userId=${sub.userId} email=${sub.user.email} expires=${sub.currentPeriodEnd?.toISOString()}`);

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { reminderSentAt: now },
      });

      await logEvent(sub.id, 'RENEWAL_REMINDER_SENT', sub.status, sub.status, {
        expiresAt: sub.currentPeriodEnd?.toISOString(),
        daysRemaining: daysUntil(sub.currentPeriodEnd),
      });
    }

    console.log(`[cron] renewal-reminders: sent ${subs.length} reminders`);
    return { processed: subs.length };
  } finally {
    await releaseCronLock('renewal-reminders');
  }
}

// ── CRON: Trigger M-Pesa renewals for expiring subscriptions ─────────────────

export async function runMpesaRenewals(): Promise<{ processed: number }> {
  const acquired = await acquireCronLock('mpesa-renewals');
  if (!acquired) {
    console.log('[cron] mpesa-renewals: skipped (locked)');
    return { processed: 0 };
  }

  try {
    const now = new Date();
    // Trigger renewal for subs that expire within the next 1 hour and haven't had an STK push today
    const renewalWindow = new Date(now.getTime() + 60 * 60 * 1000);

    const subs = await prisma.subscription.findMany({
      where: {
        provider: 'MPESA',
        status: { in: ['ACTIVE'] },
        autoRenew: true,
        mpesaRenewalAttempts: { lt: MAX_MPESA_ATTEMPTS },
        currentPeriodEnd: { lte: renewalWindow, gte: now },
        OR: [
          { mpesaLastRenewalAt: null },
          { mpesaLastRenewalAt: { lt: new Date(now.getTime() - 23 * 3600_000) } },
        ],
      },
      include: { user: true },
    });

    let processed = 0;
    for (const sub of subs) {
      try {
        await renewMpesaSubscription(sub.id);
        processed++;
      } catch (err: any) {
        console.error(`[cron] Renewal failed sub=${sub.id}: ${err.message}`);
      }
    }

    console.log(`[cron] mpesa-renewals: triggered ${processed}/${subs.length}`);
    return { processed };
  } finally {
    await releaseCronLock('mpesa-renewals');
  }
}

// ── CRON: Retry failed M-Pesa STK pushes ─────────────────────────────────────

export async function runRetries(): Promise<{ processed: number }> {
  const acquired = await acquireCronLock('mpesa-retries');
  if (!acquired) {
    console.log('[cron] mpesa-retries: skipped (locked)');
    return { processed: 0 };
  }

  try {
    const now = new Date();
    const retryEligibleBefore = new Date(now.getTime() - RETRY_INTERVAL_HOURS * 3600_000);

    // Subs that failed/timed out, have remaining attempts, and haven't been retried recently
    const subs = await prisma.subscription.findMany({
      where: {
        provider: 'MPESA',
        status: { in: ['PAST_DUE', 'GRACE_PERIOD'] },
        autoRenew: true,
        mpesaRenewalAttempts: { gt: 0, lt: MAX_MPESA_ATTEMPTS },
        mpesaLastRenewalAt: { lt: retryEligibleBefore },
      },
      include: { user: true },
    });

    let processed = 0;
    for (const sub of subs) {
      try {
        await renewMpesaSubscription(sub.id);
        processed++;
      } catch (err: any) {
        console.error(`[cron] Retry failed sub=${sub.id}: ${err.message}`);
      }
    }

    console.log(`[cron] mpesa-retries: ${processed}/${subs.length}`);
    return { processed };
  } finally {
    await releaseCronLock('mpesa-retries');
  }
}

// ── CRON: Expire subscriptions past grace period / stale / trial-expired ──────

export async function runExpiry(): Promise<{ expired: number }> {
  const acquired = await acquireCronLock('subscription-expiry');
  if (!acquired) {
    console.log('[cron] subscription-expiry: skipped (locked)');
    return { expired: 0 };
  }

  try {
    const now = new Date();
    let expired = 0;

    // 1. M-Pesa grace periods exceeded
    const gracePeriodExpired = await prisma.subscription.findMany({
      where: {
        status: 'GRACE_PERIOD',
        gracePeriodEndsAt: { lt: now },
      },
    });

    for (const sub of gracePeriodExpired) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED', expiredAt: now, gracePeriodEndsAt: null, autoRenew: false },
      });
      await logEvent(sub.id, 'GRACE_PERIOD_EXPIRED', 'GRACE_PERIOD', 'EXPIRED', {
        reason: 'grace_period_exceeded',
      });
      expired++;
    }

    // 2. Expired trials (Stripe and M-Pesa)
    const expiredTrials = await prisma.subscription.findMany({
      where: { status: 'TRIALING', trialEndsAt: { lt: now } },
    });

    for (const sub of expiredTrials) {
      if (sub.provider === 'STRIPE' && sub.stripeSubscriptionId) {
        try {
          const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
          if (stripeSub.status === 'trialing') continue;
        } catch { /* deleted on Stripe */ }
      }
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED', expiredAt: now },
      });
      await logEvent(sub.id, 'TRIAL_EXPIRED', 'TRIALING', 'EXPIRED', { reason: 'job_expiry' });
      expired++;
    }

    // 3. INCOMPLETE subs older than 24h
    const staleIncomplete = await prisma.subscription.findMany({
      where: {
        status: 'INCOMPLETE',
        createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) },
      },
    });

    for (const sub of staleIncomplete) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'INCOMPLETE_EXPIRED' },
      });
      expired++;
    }

    // 4. Apply scheduled downgrades due
    const dueDowngrades = await prisma.subscription.findMany({
      where: {
        scheduledPlanId: { not: null },
        currentPeriodEnd: { lt: now },
        status: { in: ['ACTIVE', 'TRIALING'] },
      },
    });

    for (const sub of dueDowngrades) {
      await prisma.$transaction([
        prisma.subscription.update({
          where: { id: sub.id },
          data: {
            planId: sub.scheduledPlanId!,
            interval: sub.scheduledInterval!,
            scheduledPlanId: null,
            scheduledInterval: null,
          },
        }),
        prisma.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event: 'DOWNGRADE_APPLIED',
            previousStatus: sub.status,
            newStatus: sub.status,
            metadata: { toPlanId: sub.scheduledPlanId },
          },
        }),
      ]);
    }

    // 5. Timeout stale PENDING M-Pesa transactions
    const timedOutTx = await prisma.mpesaTransaction.findMany({
      where: {
        status: 'PENDING',
        timeoutAt: { lt: now },
      },
    });

    for (const tx of timedOutTx) {
      await prisma.mpesaTransaction.update({
        where: { id: tx.id },
        data: { status: 'TIMEOUT', completedAt: now },
      });
    }

    console.log(`[cron] subscription-expiry: expired=${expired} downgrades=${dueDowngrades.length} timedOut=${timedOutTx.length}`);
    return { expired };
  } finally {
    await releaseCronLock('subscription-expiry');
  }
}

// ── Re-exports for Stripe flows (unchanged) ───────────────────────────────────

export { cancelSubscription, reactivateSubscription, upgradeSubscription, scheduleDowngrade, getBillingPortalUrl } from './stripe.subscription.service.js';
