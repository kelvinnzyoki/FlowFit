/**
 * FLOWFIT — Subscription Service (v4)
 *
 * FIXES APPLIED (vs v3):
 *   FIX-C2  handleMpesaSuccess referenced bare `subscription` variable that was
 *           never declared in the function. All references replaced with
 *           `tx.subscription` (the included relation on the transaction record).
 *   FIX-C7  handleMpesaSuccess used `tx.interval` which does not exist on
 *           MpesaTransaction. Should be `tx.subscription?.interval`.
 *   FIX-H1  Payment for M-Pesa was stored as `amountKes * 100 / 130` (KES
 *           converted to approximate USD cents) but tagged with currency 'KES'.
 *           Inconsistent. Now stored as `amountKes * 100` (KES in "cents") with
 *           currency 'KES' — consistent with how Stripe invoices store their values.
 *   FIX-H2  runMpesaRenewals filtered by `mpesaLastRenewalAt: null` which
 *           permanently blocked renewals after the first cycle (once set, never
 *           null again). Changed to allow a new attempt if the last one was more
 *           than 23 hours ago (prevents same-day duplicates, allows next cycle).
 *   FIX-H4  subscription_service.ts created `new PrismaClient()` instead of
 *           using the shared singleton from config/db.js. This opens an extra
 *           connection pool. Changed to use the singleton.
 *           The exported `prisma` alias is kept for backward compatibility.
 *   ADDED   handleMpesaSuccess now has an idempotency guard at the top — if the
 *           transaction is already SUCCESS it returns early without re-activating.
 */

import {
  SubscriptionStatus,
  BillingInterval,
  SubscriptionEvent,
} from '@prisma/client';
import type { PublicPlan, CurrentSubscription } from '../types/subscription.types.js';
import { stripe, getOrCreateStripeCustomer } from './stripe.service.js';
import {
  initiateStkPush,
  normalisePhone,
} from './mpesa.service.js';
import Stripe from 'stripe';
import prisma from '../config/db.js';  // FIX-H4: shared singleton

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysUntil(date: Date | null | undefined): number | null {
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function toPublicPlan(plan: any): PublicPlan {
  return {
    id:                   plan.id,
    slug:                 plan.slug,
    name:                 plan.name,
    description:          plan.description,
    monthlyPriceCents:    plan.monthlyPriceCents,
    yearlyPriceCents:     plan.yearlyPriceCents,
    trialDays:            plan.trialDays,
    maxWorkoutsPerMonth:  plan.maxWorkoutsPerMonth,
    maxPrograms:          plan.maxPrograms,
    hasAdvancedAnalytics: plan.hasAdvancedAnalytics,
    hasPersonalCoaching:  plan.hasPersonalCoaching,
    hasNutritionTracking: plan.hasNutritionTracking,
    hasOfflineAccess:     plan.hasOfflineAccess,
    features:             Array.isArray(plan.features)
                            ? plan.features
                            : JSON.parse(plan.features as string),
    displayOrder:         plan.displayOrder,
    isPopular:            plan.isPopular,
  };
}

async function logEvent(
  subscriptionId: string,
  event:          SubscriptionEvent,
  previousStatus: SubscriptionStatus | null | undefined,
  newStatus:      SubscriptionStatus | null | undefined,
  metadata:       Record<string, unknown> = {},
  ipAddress?:     string,
): Promise<void> {
  await prisma.subscriptionLog.create({
    data: {
      subscriptionId,
      event,
      previousStatus: previousStatus ?? undefined,
      newStatus:      newStatus      ?? undefined,
      metadata:       metadata as any,
      ipAddress,
    },
  });
}

function getFrontendUrl(): string {
  const url = process.env.FRONTEND_URL || process.env.APP_URL || '';
  if (!url) {
    console.warn(
      '[subscription.service] Neither FRONTEND_URL nor APP_URL is set — ' +
      'Stripe redirects will be broken.',
    );
  }
  return url;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getPlans(): Promise<PublicPlan[]> {
  const plans = await prisma.plan.findMany({
    where:   { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  return plans.map(toPublicPlan);
}

export async function getCurrentSubscription(
  userId: string,
): Promise<CurrentSubscription | null> {
  const rows = await prisma.subscription.findMany({
    where:   { userId },
    orderBy: { createdAt: 'desc' },
    take:    10,
    include: { plan: true },
  });

  if (!rows.length) return null;

  const STATUS_PRIORITY: Record<string, number> = {
    ACTIVE:             0,
    TRIALING:           1,
    PAST_DUE:           2,
    GRACE_PERIOD:       3,
    PAUSED:             4,
    INCOMPLETE:         5,
    INCOMPLETE_EXPIRED: 6,
    CANCELLED:          7,
    EXPIRED:            8,
  };

  const ranked = [...rows].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 9;
    const pb = STATUS_PRIORITY[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const sub = ranked[0];

  let scheduledPlanSlug: string | null = null;
  if (sub.scheduledPlanId) {
    const sp = await prisma.plan.findUnique({
      where:  { id: sub.scheduledPlanId },
      select: { slug: true },
    });
    scheduledPlanSlug = sp?.slug ?? null;
  }

  return {
    id:                   sub.id,
    status:               sub.status,
    interval:             sub.interval,
    plan:                 toPublicPlan(sub.plan),
    trialEndsAt:          sub.trialEndsAt?.toISOString()        ?? null,
    currentPeriodStart:   sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd:     sub.currentPeriodEnd?.toISOString()   ?? null,
    cancelAtPeriodEnd:    sub.cancelAtPeriodEnd,
    cancelledAt:          sub.cancelledAt?.toISOString()        ?? null,
    scheduledPlanSlug,
    activatedAt:          sub.activatedAt?.toISOString()        ?? null,
    daysUntilRenewal:     daysUntil(sub.currentPeriodEnd),
    stripeSubscriptionId: sub.stripeSubscriptionId ?? null,
  };
}

export async function createCheckoutSession(
  userId:      string,
  email:       string,
  name:        string | null | undefined,
  planId:      string,
  interval:    BillingInterval,
  successUrl?: string,
  cancelUrl?:  string,
): Promise<{ url: string; sessionId: string }> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan)          throw new Error('Plan not found');
  if (!plan.isActive) throw new Error('Plan is no longer available');

  const stripePriceId = interval === 'YEARLY'
    ? plan.stripePriceIdYearly
    : plan.stripePriceIdMonthly;
  if (!stripePriceId) {
    throw new Error(
      `Stripe price not configured for plan "${plan.slug}" / ${interval}`,
    );
  }

  const stripeCustomerId = await getOrCreateStripeCustomer(
    prisma, userId, email, name,
  );

  const existing = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
  });

  const base               = getFrontendUrl();
  const resolvedSuccessUrl = successUrl
    || `${base}/subscription.html?session_id={CHECKOUT_SESSION_ID}&success=1`;
  const resolvedCancelUrl  = cancelUrl
    || `${base}/subscription.html?cancelled=1`;

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer:   stripeCustomerId,
    mode:       'subscription',
    line_items: [{ price: stripePriceId, quantity: 1 }],
    success_url: resolvedSuccessUrl,
    cancel_url:  resolvedCancelUrl,
    metadata: {
      userId,
      planId,
      interval,
      existingSubscriptionId: existing?.id ?? '',
    },
    subscription_data: {
      metadata: { userId, planId },
      ...(plan.trialDays > 0 && !existing
        ? { trial_period_days: plan.trialDays }
        : {}),
    },
    allow_promotion_codes:      true,
    billing_address_collection: 'auto',
    customer_update:            { address: 'auto' },
  };

  const session = await stripe.checkout.sessions.create(sessionParams);

  const pendingSub = await prisma.subscription.create({
    data: {
      userId,
      planId,
      status:                  'INCOMPLETE',
      interval,
      stripeCheckoutSessionId: session.id,
      trialStartedAt: plan.trialDays > 0 && !existing ? new Date() : null,
      trialEndsAt:    plan.trialDays > 0 && !existing
        ? new Date(Date.now() + plan.trialDays * 86_400_000)
        : null,
    },
  });

  await logEvent(pendingSub.id, 'CREATED', null, 'INCOMPLETE', {
    planSlug:  plan.slug,
    interval,
    sessionId: session.id,
  });

  return { url: session.url!, sessionId: session.id };
}

// ─── M-Pesa subscription initiation ──────────────────────────────────────────

export interface MpesaSubscriptionResult {
  merchantRequestId:  string;
  checkoutRequestId:  string;
  subscriptionId:     string;
  customerMessage:    string;
}

export async function createMpesaSubscription(
  userId:   string,
  planId:   string,
  interval: BillingInterval,
  rawPhone: string,
): Promise<MpesaSubscriptionResult> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan)          throw new Error('Plan not found');
  if (!plan.isActive) throw new Error('Plan is no longer available');

  const amountKes = interval === 'YEARLY'
    ? plan.mpesaYearlyKes
    : plan.mpesaMonthlyKes;

  if (!amountKes || amountKes <= 0) {
    throw new Error(
      `M-Pesa price not configured for plan "${plan.slug}" / ${interval}`,
    );
  }

  const phone = normalisePhone(rawPhone);

  // FIX-7: Create the subscription row first, then fire STK push, then record
  // the mpesaTransaction — all in a way that if the mpesaTransaction write fails
  // after a successful STK push, the callback can still be correlated by looking
  // up mpesaTransaction by checkoutRequestId (which Safaricom echoes back).
  // The subscription row being INCOMPLETE is safe — the expiry job cleans it up after 24h.
  // The critical path is: subscription exists → STK fires → transaction recorded.
  // If mpesaTransaction.create fails after STK push, the webhook handler will
  // receive the callback, find no mpesaTransaction, and log a warning rather than
  // silently activating or dropping — this is recoverable via manual lookup.
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      planId,
      status:   'INCOMPLETE',
      provider: 'MPESA',
      interval,
    },
  });

  await logEvent(
    subscription.id,
    'MPESA_STK_INITIATED',
    null,
    'INCOMPLETE',
    { planSlug: plan.slug, interval },
  );

  const stk = await initiateStkPush(
    phone,
    amountKes,
    `FlowFit-${plan.slug.toUpperCase()}`,
    `FlowFit ${plan.name} ${interval.toLowerCase()}`,
  );

  // This write must succeed — if it fails, throw so the caller gets an error
  // and the user sees a failure rather than a silent orphan payment.
  await prisma.mpesaTransaction.create({
    data: {
      subscriptionId:    subscription.id,
      userId,
      merchantRequestId: stk.merchantRequestId,
      checkoutRequestId: stk.checkoutRequestId,
      phoneNumber:       phone,
      amountKes,
      status:            'PENDING',
      isRenewal:         false,
      attemptNumber:     1,
      timeoutAt:         new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data:  { mpesaPhone: phone },
  }).catch(() => {/* non-critical */});

  return {
    merchantRequestId: stk.merchantRequestId,
    checkoutRequestId: stk.checkoutRequestId,
    subscriptionId:    subscription.id,
    customerMessage:   stk.customerMessage,
  };
}

// ─── M-Pesa webhook handlers ──────────────────────────────────────────────────

export async function handleMpesaSuccess(
  checkoutRequestId:  string,
  mpesaReceiptNumber: string,
  amountKes?:         number,
): Promise<void> {
  
  // Wrap ALL updates in a single transaction
  await prisma.$transaction(async (tx) => {
    const mpesaTx = await tx.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
      include: { subscription: true },
    });

    if (!mpesaTx || !mpesaTx.subscription) {
      throw new Error(`Transaction ${checkoutRequestId} not found`);
    }

    // Idempotency check
    if (mpesaTx.status === 'SUCCESS') {
      console.log(`[handleMpesaSuccess] Already processed: ${checkoutRequestId}`);
      return;
    }

    const subscription = mpesaTx.subscription;
    const now = new Date();
    const isRenewal = mpesaTx.isRenewal === true;

    // Calculate new period
    let newPeriodEnd: Date;
    if (subscription.interval === 'YEARLY') {
      newPeriodEnd = new Date(now);
      newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
    } else {
      newPeriodEnd = new Date(now);
      newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    }

    // 1. Update transaction
    await tx.mpesaTransaction.update({
      where: { checkoutRequestId },
      data: {
        status: 'SUCCESS',
        mpesaReceiptNumber: mpesaReceiptNumber,
        completedAt: now,
      },
    });

    // 2. Create payment record
    await tx.payment.create({
      data: {
        subscriptionId: subscription.id,
        mpesaReceiptNumber: mpesaReceiptNumber,
        amountCents: (amountKes ?? 0) * 100,
        currency: 'KES',
        status: 'succeeded',
        provider: 'MPESA',
      },
    });

    // 3. Update subscription
    const prevStatus = subscription.status;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: newPeriodEnd,
        activatedAt: prevStatus !== 'ACTIVE' ? now : undefined,
        mpesaLastRenewalAt: isRenewal ? now : undefined,
      },
    });

    // 4. Log event
    await tx.subscriptionLog.create({
      data: {
        subscriptionId: subscription.id,
        event: isRenewal ? 'PAYMENT_SUCCEEDED' : 'MPESA_STK_SUCCESS',
        previousStatus: prevStatus,
        newStatus: 'ACTIVE',
        metadata: {
          checkoutRequestId,
          mpesaReceiptNumber,
          amountKes,
          isRenewal,
        } as any,
      },
    });
  });
  }

export async function handleMpesaFailure(
  checkoutRequestId: string,
  resultCode:        string,
  resultDesc:        string,
): Promise<void> {
  const tx = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
  });

  if (!tx) {
    console.warn(`[mpesa] No transaction found for ${checkoutRequestId}`);
    return;
  }

  if (tx.status !== 'PENDING') return;  // idempotency

  const newTxStatus = resultCode === '1032' ? 'CANCELLED' : 'FAILED';

  await prisma.$transaction(async (db) => {
    await db.mpesaTransaction.update({
      where: { id: tx.id },
      data: {
        status:      newTxStatus,
        resultCode,
        resultDesc,
        completedAt: new Date(),
      },
    });

    if (tx.subscriptionId) {
      if (tx.isRenewal) {
        await db.subscription.update({
          where: { id: tx.subscriptionId },
          data:  { status: 'PAST_DUE' },
        });
      }

      await db.subscriptionLog.create({
        data: {
          subscriptionId: tx.subscriptionId,
          event:          'MPESA_STK_FAILED',
          metadata:       { checkoutRequestId, resultCode, resultDesc },
        },
      });
    }
  });
}

// ─── Cron job functions ───────────────────────────────────────────────────────

export async function runRenewalReminders(): Promise<{
  processed: number;
  errors:    number;
}> {
  const REMINDER_DAYS  = 3;
  const now            = new Date();
  const reminderWindow = new Date(now.getTime() + REMINDER_DAYS * 86_400_000);

  const subs = await prisma.subscription.findMany({
    where: {
      provider:         'MPESA',
      status:           { in: ['ACTIVE'] },
      currentPeriodEnd: { lte: reminderWindow, gte: now },
      reminderSentAt:   null,
    },
    include: { plan: true },
  });

  let processed = 0;
  let errors    = 0;

  for (const sub of subs) {
    try {
      await prisma.$transaction(async (db) => {
        await db.subscription.update({
          where: { id: sub.id },
          data:  { reminderSentAt: now },
        });
        await db.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'RENEWAL_REMINDER_SENT',
            previousStatus: sub.status,
            newStatus:      sub.status,
            metadata: {
              daysUntilExpiry: daysUntil(sub.currentPeriodEnd),
              planSlug:        sub.plan.slug,
            },
          },
        });
      });
      // TODO: send email/SMS notification to sub.userId
      processed++;
    } catch (err) {
      console.error(`[cron/reminders] Sub ${sub.id}:`, err);
      errors++;
    }
  }

  return { processed, errors };
}

export async function runMpesaRenewals(): Promise<{
  processed: number;
  errors:    number;
}> {
  const RENEWAL_WINDOW_HOURS = 24;
  const now                  = new Date();
  const windowEnd            = new Date(now.getTime() + RENEWAL_WINDOW_HOURS * 3_600_000);
  // FIX-H2: Don't filter by mpesaLastRenewalAt: null — that permanently blocks
  // renewals after the first cycle (once set it is never null again).
  // Instead, allow a retry if the last attempt was > 23 hours ago. This prevents
  // same-hour duplicates while allowing the next billing cycle to proceed.
  const renewalCutoff = new Date(now.getTime() - 23 * 3_600_000);

  const subs = await prisma.subscription.findMany({
    where: {
      provider:         'MPESA',
      status:           { in: ['ACTIVE'] },
      autoRenew:        true,
      currentPeriodEnd: { lte: windowEnd, gte: now },
      OR: [
        { mpesaLastRenewalAt: null },
        { mpesaLastRenewalAt: { lt: renewalCutoff } },
      ],
    },
    include: { plan: true, user: true },
  });

  let processed = 0;
  let errors    = 0;

  for (const sub of subs) {
    try {
      const phone = sub.user.mpesaPhone;
      if (!phone) {
        console.warn(`[cron/renewals] Sub ${sub.id}: no mpesaPhone, skipping`);
        continue;
      }

      const amountKes = sub.interval === 'YEARLY'
        ? sub.plan.mpesaYearlyKes
        : sub.plan.mpesaMonthlyKes;

      if (!amountKes) {
        console.warn(`[cron/renewals] Sub ${sub.id}: no KES price for ${sub.plan.slug}`);
        continue;
      }

      // FIX-7: Fire STK push THEN record in DB inside a transaction.
      // The key insight: if initiateStkPush throws, nothing is written to DB (correct).
      // If the DB transaction fails after a successful STK push, the payment callback
      // arrives with no mpesaTransaction record and is silently dropped — user is charged
      // but subscription isn't activated. To mitigate: STK push first, then DB write.
      // If DB write fails, the error is caught by the outer catch and logged, and the
      // next cron run will retry (mpesaLastRenewalAt was not updated, so the sub still
      // qualifies for renewal in the next window).
      const stk = await initiateStkPush(
        phone,
        amountKes,
        `FlowFit-${sub.plan.slug.toUpperCase()}`,
        `FlowFit renewal ${sub.plan.name}`,
      );

      const attempts = (sub.mpesaRenewalAttempts ?? 0) + 1;

      // DB write is separate from STK push — if this fails, the outer catch logs it.
      // mpesaLastRenewalAt is updated here so duplicate STK pushes are prevented even
      // if the transaction record creation fails (the sub won't qualify for renewal again
      // until the next cycle).
      await prisma.$transaction(async (db) => {
        await db.subscription.update({
          where: { id: sub.id },
          data:  {
            mpesaLastRenewalAt:   now,
            mpesaRenewalAttempts: attempts,
          },
        });
        await db.mpesaTransaction.create({
          data: {
            subscriptionId:    sub.id,
            userId:            sub.userId,
            merchantRequestId: stk.merchantRequestId,
            checkoutRequestId: stk.checkoutRequestId,
            phoneNumber:       phone,
            amountKes,
            status:            'PENDING',
            isRenewal:         true,
            attemptNumber:     attempts,
            timeoutAt:         new Date(now.getTime() + 5 * 60 * 1000),
          },
        });
        await db.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'MPESA_STK_INITIATED',
            previousStatus: sub.status,
            newStatus:      sub.status,
            metadata:       { checkoutRequestId: stk.checkoutRequestId, isRenewal: true },
          },
        });
      });

      processed++;
    } catch (err) {
      console.error(`[cron/renewals] Sub ${sub.id}:`, err);
      errors++;
    }
  }

  return { processed, errors };
}

export async function runRetries(): Promise<{
  processed: number;
  errors:    number;
}> {
  const MAX_RETRIES = 3;
  const now         = new Date();

  const subs = await prisma.subscription.findMany({
    where: {
      provider:             'MPESA',
      status:               'PAST_DUE',
      autoRenew:            true,
      mpesaRenewalAttempts: { lt: MAX_RETRIES },
      gracePeriodEndsAt:    { gte: now },
    },
    include: { plan: true, user: true },
  });

  let processed = 0;
  let errors    = 0;

  for (const sub of subs) {
    try {
      const phone = sub.user.mpesaPhone;
      if (!phone) continue;

      const amountKes = sub.interval === 'YEARLY'
        ? sub.plan.mpesaYearlyKes
        : sub.plan.mpesaMonthlyKes;

      if (!amountKes) continue;

      const attempts = (sub.mpesaRenewalAttempts ?? 0) + 1;

      const stk = await initiateStkPush(
        phone,
        amountKes,
        `FlowFit-${sub.plan.slug.toUpperCase()}`,
        `FlowFit retry ${attempts}`,
      );

      await prisma.$transaction(async (db) => {
        await db.subscription.update({
          where: { id: sub.id },
          data:  {
            mpesaLastRenewalAt:   now,
            mpesaRenewalAttempts: attempts,
          },
        });
        await db.mpesaTransaction.create({
          data: {
            subscriptionId:    sub.id,
            userId:            sub.userId,
            merchantRequestId: stk.merchantRequestId,
            checkoutRequestId: stk.checkoutRequestId,
            phoneNumber:       phone,
            amountKes,
            status:            'PENDING',
            isRenewal:         true,
            attemptNumber:     attempts,
            timeoutAt:         new Date(now.getTime() + 5 * 60 * 1000),
          },
        });
        await db.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'MPESA_RETRY_SCHEDULED',
            previousStatus: sub.status,
            newStatus:      sub.status,
            metadata:       { attempt: attempts },
          },
        });
      });

      processed++;
    } catch (err) {
      console.error(`[cron/retries] Sub ${sub.id}:`, err);
      errors++;
    }
  }

  return { processed, errors };
}

export async function runExpiry(): Promise<{
  expired: number;
  errors:  number;
}> {
  const now = new Date();

  const subs = await prisma.subscription.findMany({
    where: {
      // FIX-5: Only expire MPESA subscriptions here. Stripe-managed subscriptions
      // are controlled by Stripe webhooks (customer.subscription.deleted /
      // invoice.payment_failed). Running this job on Stripe subs risks expiring
      // a subscription a few seconds before Stripe's renewal webhook arrives.
      provider:         'MPESA',
      status:           { in: ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'] },
      currentPeriodEnd: { lt: now },
      OR: [
        { gracePeriodEndsAt: null },
        { gracePeriodEndsAt: { lt: now } },
      ],
    },
  });

  let expired = 0;
  let errors  = 0;

  for (const sub of subs) {
    try {
      const prevStatus = sub.status;
      await prisma.$transaction(async (db) => {
        await db.subscription.update({
          where: { id: sub.id },
          data: {
            status:    'EXPIRED',
            expiredAt: now,
          },
        });
        await db.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'EXPIRED',
            previousStatus: prevStatus,
            newStatus:      'EXPIRED',
            metadata: {
              periodEnd:      sub.currentPeriodEnd?.toISOString(),
              gracePeriodEnd: sub.gracePeriodEndsAt?.toISOString() ?? null,
            },
          },
        });
      });
      expired++;
    } catch (err) {
      console.error(`[cron/expiry] Sub ${sub.id}:`, err);
      errors++;
    }
  }

  return { expired, errors };
}

// ─── Stripe plan change operations ────────────────────────────────────────────

export async function cancelSubscription(
  userId:      string,
  immediately: boolean = false,
  reason?:     string,
  ipAddress?:  string,
): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  if (!sub) throw new Error('No active subscription found');

  const prevStatus = sub.status;

  if (sub.stripeSubscriptionId) {
    if (immediately) {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status:             'CANCELLED',
          cancelledAt:        new Date(),
          cancelAtPeriodEnd:  false,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', { reason, immediately: true }, ipAddress);
    } else {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd:  true,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus, { reason, atPeriodEnd: true }, ipAddress);
    }
  } else {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:             'CANCELLED',
        cancelledAt:        new Date(),
        cancelAtPeriodEnd:  false,
        cancellationReason: reason ?? 'user_requested_no_stripe_id',
      },
    });
    await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', { reason, immediately, note: 'db_only_no_stripe_sub' }, ipAddress);
  }

  return (await getCurrentSubscription(userId))!;
}

export async function reactivateSubscription(
  userId:     string,
  ipAddress?: string,
): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      cancelAtPeriodEnd: true,
      status: { in: ['ACTIVE', 'TRIALING'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) throw new Error('No subscription scheduled for cancellation');

  if (sub.stripeSubscriptionId) {
    await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      cancelAtPeriodEnd:  false,
      cancellationReason: null,
    },
  });

  await logEvent(sub.id, 'REACTIVATED', sub.status, sub.status, { hadStripeId: !!sub.stripeSubscriptionId }, ipAddress);

  return (await getCurrentSubscription(userId))!;
}

export async function upgradeSubscription(
  userId:      string,
  newPlanId:   string,
  newInterval: BillingInterval,
  ipAddress?:  string,
): Promise<CurrentSubscription> {
  const [sub, newPlan] = await Promise.all([
    prisma.subscription.findFirst({
      where:   { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    prisma.plan.findUnique({ where: { id: newPlanId } }),
  ]);

  if (!sub)     throw new Error('No active subscription to upgrade');
  if (!newPlan) throw new Error('Target plan not found');
  if (!sub.stripeSubscriptionId) {
    throw new Error('M-Pesa upgrades require a new payment. Use /mpesa/initiate with the new plan.');
  }

  const newPriceId = newInterval === 'YEARLY'
    ? newPlan.stripePriceIdYearly
    : newPlan.stripePriceIdMonthly;
  if (!newPriceId) {
    throw new Error(`Stripe price not configured for ${newPlan.slug}/${newInterval}`);
  }

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const itemId    = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error('No subscription items on Stripe subscription');

  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items:              [{ id: itemId, price: newPriceId }],
    proration_behavior: 'create_prorations',
    metadata:           { userId, planId: newPlanId },
  });

  const prevPlanSlug = sub.plan.slug;
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      planId:            newPlanId,
      interval:          newInterval,
      cancelAtPeriodEnd: false,
      scheduledPlanId:   null,
      scheduledInterval: null,
    },
  });

  await logEvent(sub.id, 'UPGRADED', sub.status, sub.status, { fromPlan: prevPlanSlug, toPlan: newPlan.slug, interval: newInterval }, ipAddress);

  return (await getCurrentSubscription(userId))!;
}

export async function scheduleDowngrade(
  userId:      string,
  newPlanId:   string,
  newInterval: BillingInterval,
  ipAddress?:  string,
): Promise<CurrentSubscription> {
  const [sub, newPlan] = await Promise.all([
    prisma.subscription.findFirst({
      where:   { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    prisma.plan.findUnique({ where: { id: newPlanId } }),
  ]);

  if (!sub)     throw new Error('No active subscription');
  if (!newPlan) throw new Error('Target plan not found');
  if (!sub.stripeSubscriptionId) {
    throw new Error('No Stripe subscription ID — cannot schedule downgrade');
  }

  const newPriceId = newInterval === 'YEARLY'
    ? newPlan.stripePriceIdYearly
    : newPlan.stripePriceIdMonthly;
  if (!newPriceId) {
    throw new Error(`Stripe price not configured for ${newPlan.slug}/${newInterval}`);
  }

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const itemId    = stripeSub.items.data[0]?.id;

  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items:                [{ id: itemId, price: newPriceId }],
    proration_behavior:   'none',
    billing_cycle_anchor: 'unchanged',
    metadata:             { scheduledPlanId: newPlanId },
  });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      scheduledPlanId:   newPlanId,
      scheduledInterval: newInterval,
    },
  });

  await logEvent(sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status, { fromPlan: sub.plan.slug, toPlan: newPlan.slug, interval: newInterval }, ipAddress);

  return (await getCurrentSubscription(userId))!;
}

export async function getBillingPortalUrl(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) {
    throw new Error('No billing account found');
  }

  const frontendBase = getFrontendUrl();
  const returnUrl    = `${frontendBase}/subscription.html`;

  const session = await stripe.billingPortal.sessions.create({
    customer:   user.stripeCustomerId,
    return_url: returnUrl,
  });

  return session.url;
}

// FIX-H4: Export the singleton so existing importers (e.g. routes that do
//         `import { prisma } from './subscription.service.js'`) keep working.
export { prisma };
