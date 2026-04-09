/**
 * FLOWFIT — Subscription Service (v5)
 *
 * FIXES APPLIED (vs v4):
 *   NEW-R1  handleMpesaSuccess: on success, explicitly clear gracePeriodEndsAt
 *           and set mpesaRenewalAttempts = 0. Previously a successful renewal
 *           after a PAST_DUE period left the grace period timestamp in place,
 *           causing the expiry job to incorrectly expire an active subscription.
 *
 *   NEW-R2  handleMpesaFailure: map M-Pesa result codes to meaningful states.
 *           1032 = user cancelled (CANCELLED, not retriable immediately).
 *           1037 = device unreachable/timeout (TIMEOUT status, IS retriable).
 *           All other non-zero codes = FAILED.
 *           On renewal failure, set gracePeriodEndsAt = now + 3 days so the
 *           user keeps access during the retry window instead of being cut off.
 *
 *   NEW-R3  runExpiry: before expiring, double-check for a recent SUCCESS
 *           mpesaTransaction in the last 2 hours. Protects against the race
 *           where a webhook callback arrives just as the expiry job runs.
 *
 *   NEW-R4  createMpesaSubscription / createCheckoutSession: block if user
 *           already has an ACTIVE or TRIALING subscription from any provider.
 *           Prevents cross-provider duplicate active subscriptions.
 *
 *   NEW-R5  runReconciliation: new export. Scans M-Pesa SUCCESS transactions
 *           from the last 48h, verifies each has a Payment record and the
 *           subscription is ACTIVE. Fixes any drift found atomically and logs
 *           a console alert for each drifted record.
 *
 *   NEW-R6  runMpesaRenewals / runRetries: on STK initiation, immediately set
 *           gracePeriodEndsAt = currentPeriodEnd + 3 days so users in the
 *           renewal window keep access even if the callback is delayed.
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

  // NEW-R4: Block if the user already has an active or trialing subscription
  // from ANY provider. Without this, a Stripe checkout could run while an
  // M-Pesa subscription is active, creating two concurrent paid subscriptions.
  const activeAnySub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (activeAnySub) {
    throw new Error(
      `User already has an ${activeAnySub.status} ${activeAnySub.provider} subscription. ` +
      'Cancel or upgrade the existing subscription first.',
    );
  }

  const existing = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['PAST_DUE'] } },
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
      // Only offer a trial if no prior sub exists at all (not even PAST_DUE)
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

  // NEW-R4: Block cross-provider duplicate active subscriptions.
  // A user must not have an ACTIVE or TRIALING sub (Stripe or M-Pesa) when
  // initiating a new M-Pesa payment. Routes also check this, but we enforce
  // it here as a last-line guard so the service is self-consistent.
  const activeAnySub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (activeAnySub) {
    throw new Error(
      `User already has an ${activeAnySub.status} ${activeAnySub.provider} subscription. ` +
      'Cancel or upgrade the existing subscription first.',
    );
  }

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

    // 3. Update subscription — explicitly clear grace period fields so a
    //    previously PAST_DUE sub doesn't get re-expired by the expiry job.
    // NEW-R1: Always clear gracePeriodEndsAt and reset mpesaRenewalAttempts on
    //         successful payment. Without this, a sub that recovered from PAST_DUE
    //         still had a past gracePeriodEndsAt, causing the expiry job to
    //         immediately expire it on the next run.
    const prevStatus = subscription.status;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status:               'ACTIVE',
        currentPeriodStart:   now,
        currentPeriodEnd:     newPeriodEnd,
        activatedAt:          prevStatus !== 'ACTIVE' ? now : undefined,
        mpesaLastRenewalAt:   isRenewal ? now : undefined,
        gracePeriodEndsAt:    null,   // NEW-R1: clear any leftover grace period
        mpesaRenewalAttempts: 0,      // NEW-R1: reset retry counter after success
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
    where:   { checkoutRequestId },
    include: { subscription: true },
  });

  if (!tx) {
    console.warn(`[mpesa] No transaction found for ${checkoutRequestId}`);
    return;
  }

  if (tx.status !== 'PENDING') return;  // idempotency

  // NEW-R2: Map M-Pesa result codes to meaningful transaction states.
  //   1032 = user explicitly cancelled the STK prompt — not retriable immediately.
  //   1037 = device unreachable / STK timeout — IS retriable (transient network issue).
  //   All others = hard FAILED.
  let newTxStatus: 'CANCELLED' | 'FAILED' | 'TIMEOUT';
  let isRetriable = false;
  if (resultCode === '1032') {
    newTxStatus = 'CANCELLED';
    console.log(`[mpesa] ${checkoutRequestId}: user cancelled STK prompt (1032)`);
  } else if (resultCode === '1037') {
    newTxStatus = 'TIMEOUT';
    isRetriable = true;
    console.log(`[mpesa] ${checkoutRequestId}: device unreachable/timeout (1037) — retriable`);
  } else {
    newTxStatus = 'FAILED';
    console.log(`[mpesa] ${checkoutRequestId}: STK failed (code ${resultCode}): ${resultDesc}`);
  }

  const now = new Date();

  await prisma.$transaction(async (db) => {
    await db.mpesaTransaction.update({
      where: { id: tx.id },
      data: {
        status:      newTxStatus,
        resultCode,
        resultDesc,
        completedAt: now,
      },
    });

    if (tx.subscriptionId) {
      if (tx.isRenewal) {
        // NEW-R2: On renewal failure, move to PAST_DUE AND set a grace period of
        //         3 days so the user keeps access during the retry window.
        //         Without gracePeriodEndsAt, the expiry job fires next run and
        //         cuts the user off before retries have a chance to succeed.
        const gracePeriodEndsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        await db.subscription.update({
          where: { id: tx.subscriptionId },
          data: {
            status:           'PAST_DUE',
            gracePeriodEndsAt,
          },
        });
        console.log(
          `[mpesa] Sub ${tx.subscriptionId} moved to PAST_DUE. ` +
          `Grace period until ${gracePeriodEndsAt.toISOString()}. ` +
          `Retriable: ${isRetriable}`,
        );
      }

      await db.subscriptionLog.create({
        data: {
          subscriptionId: tx.subscriptionId,
          event:          'MPESA_STK_FAILED',
          metadata:       {
            checkoutRequestId,
            resultCode,
            // NEW-R2: include retriable flag so dunning logic can act on it
            retriable: isRetriable,
            codeLabel: resultCode === '1032' ? 'user_cancelled'
                     : resultCode === '1037' ? 'device_unreachable'
                     : 'payment_failed',
          },
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
            // NEW-R6: Set grace period from STK initiation time so the user keeps
            // access while we await the Safaricom callback (can take up to 30s).
            // The expiry job won't cut them off during this window.
            gracePeriodEndsAt: new Date(
              (sub.currentPeriodEnd ?? now).getTime() + 3 * 24 * 60 * 60 * 1000
            ),
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
            // NEW-R6: Extend grace period from now so user keeps access
            // while this retry STK push is pending.
            gracePeriodEndsAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
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
      // NEW-R3: Before expiring, check for a SUCCESS mpesaTransaction in the
      // last 2 hours. This guards against the race where a Safaricom callback
      // arrives just as the expiry job runs — the webhook handler sets status
      // ACTIVE, then this job immediately flips it back to EXPIRED.
      // If a recent success exists, the handleMpesaSuccess transaction already
      // updated currentPeriodEnd, so this sub will no longer match the query
      // on the next run. We skip it here to be safe.
      const recentSuccess = await prisma.mpesaTransaction.findFirst({
        where: {
          subscriptionId: sub.id,
          status:         'SUCCESS',
          completedAt:    { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
        },
      });
      if (recentSuccess) {
        console.log(
          `[cron/expiry] Sub ${sub.id}: skipping expiry — recent SUCCESS tx ` +
          `${recentSuccess.id} found (${recentSuccess.completedAt?.toISOString()})`,
        );
        continue;
      }

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

// ─── Reconciliation job ───────────────────────────────────────────────────────

/**
 * NEW-R5: runReconciliation
 *
 * Scans every M-Pesa SUCCESS transaction from the last 48 hours and verifies:
 *   1. A matching Payment record exists for the receipt number.
 *   2. The linked subscription is ACTIVE (not PAST_DUE / EXPIRED).
 *   3. currentPeriodEnd is in the future.
 *
 * Any drift found is fixed atomically inside a transaction and logged to the
 * console so it shows up in Vercel logs / any log aggregator you add later.
 *
 * Run this daily via POST /internal/cron/reconcile (added to cron_routes.ts).
 *
 * TODO: wire up an email/Slack alert when driftCount > 0.
 */
export async function runReconciliation(): Promise<{
  checked:    number;
  fixed:      number;
  errors:     number;
}> {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const now   = new Date();

  // Fetch all SUCCESS M-Pesa transactions in the last 48h that have a subscription
  const txns = await prisma.mpesaTransaction.findMany({
    where: {
      status:      'SUCCESS',
      completedAt: { gte: since },
      subscriptionId: { not: null },
    },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
    orderBy: { completedAt: 'asc' },
  });

  let checked = 0;
  let fixed   = 0;
  let errors  = 0;

  for (const tx of txns) {
    checked++;

    const sub = tx.subscription;
    if (!sub) continue; // subscriptionId was null-joined

    try {
      // ── Check 1: Payment record exists ───────────────────────────────────
      const paymentExists = tx.mpesaReceiptNumber
        ? await prisma.payment.findFirst({
            where: { mpesaReceiptNumber: tx.mpesaReceiptNumber },
          })
        : null;

      // ── Check 2: Subscription is ACTIVE with a future period end ─────────
      const subIsHealthy =
        sub.status === 'ACTIVE' &&
        sub.currentPeriodEnd != null &&
        sub.currentPeriodEnd > now;

      if (paymentExists && subIsHealthy) continue; // no drift — all good

      // ── Drift detected — log it ───────────────────────────────────────────
      console.warn(
        `[reconcile] DRIFT detected — tx ${tx.id} ` +
        `receipt ${tx.mpesaReceiptNumber ?? 'N/A'} | ` +
        `sub ${sub.id} status=${sub.status} ` +
        `periodEnd=${sub.currentPeriodEnd?.toISOString() ?? 'null'} | ` +
        `paymentRecord=${paymentExists ? 'EXISTS' : 'MISSING'}`,
      );

      // ── Fix drift atomically ──────────────────────────────────────────────
      // Recalculate period end from the transaction's completedAt (source of truth).
      const baseDate = tx.completedAt ?? now;
      let repairedPeriodEnd: Date;
      if (sub.interval === 'YEARLY') {
        repairedPeriodEnd = new Date(baseDate);
        repairedPeriodEnd.setFullYear(repairedPeriodEnd.getFullYear() + 1);
      } else {
        repairedPeriodEnd = new Date(baseDate);
        repairedPeriodEnd.setMonth(repairedPeriodEnd.getMonth() + 1);
      }

      await prisma.$transaction(async (db) => {
        // 1. Create missing Payment record if needed
        if (!paymentExists && tx.mpesaReceiptNumber) {
          await db.payment.create({
            data: {
              subscriptionId:    sub.id,
              mpesaReceiptNumber: tx.mpesaReceiptNumber,
              amountCents:       (tx.amountKes ?? 0) * 100,
              currency:          'KES',
              status:            'succeeded',
              provider:          'MPESA',
            },
          });
        }

        // 2. Fix subscription status and period if drifted
        if (!subIsHealthy) {
          await db.subscription.update({
            where: { id: sub.id },
            data: {
              status:             'ACTIVE',
              currentPeriodStart: tx.completedAt ?? now,
              currentPeriodEnd:   repairedPeriodEnd,
              gracePeriodEndsAt:  null,
              mpesaRenewalAttempts: 0,
              activatedAt:        sub.activatedAt ?? now,
            },
          });
        }

        // 3. Log the reconciliation event
        await db.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'PAYMENT_SUCCEEDED', // closest existing event type
            previousStatus: sub.status as any,
            newStatus:      'ACTIVE',
            metadata: {
              reconciled:        true,
              txId:              tx.id,
              receiptNumber:     tx.mpesaReceiptNumber,
              missingPayment:    !paymentExists,
              statusWas:         sub.status,
              repairedPeriodEnd: repairedPeriodEnd.toISOString(),
              // TODO: trigger Slack/email alert here when driftCount > threshold
            } as any,
          },
        });
      });

      fixed++;
      console.log(`[reconcile] Fixed sub ${sub.id} — status restored to ACTIVE, period reset.`);

    } catch (err) {
      console.error(`[reconcile] Error processing tx ${tx.id}:`, err);
      errors++;
    }
  }

  console.log(`[reconcile] Done — checked=${checked} fixed=${fixed} errors=${errors}`);
  return { checked, fixed, errors };
}
