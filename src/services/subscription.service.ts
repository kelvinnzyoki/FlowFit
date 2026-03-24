/**
 * FLOWFIT — Subscription Service (v3)
 *
 * Changes vs v2:
 *
 *  FIX-A  stripeSubscriptionId added to getCurrentSubscription return value.
 *         Previously caused TS2353 because CurrentSubscription type was missing
 *         this field. Type is updated in subscription.types.ts.
 *
 *  FIX-B  createMpesaSubscription — new export.
 *         subscription.routes.ts imports this for POST /mpesa/initiate.
 *         Initiates a Daraja STK Push, creates a Subscription (provider=MPESA,
 *         status=INCOMPLETE) and a MpesaTransaction record, returns the IDs
 *         needed by the route handler.
 *
 *  FIX-C  handleMpesaSuccess / handleMpesaFailure — new exports.
 *         mpesa.webhook.routes.ts imports these to process Daraja callbacks.
 *         handleMpesaSuccess activates the subscription; handleMpesaFailure
 *         marks the transaction and optionally the subscription as PAST_DUE.
 *
 *  FIX-D  runRenewalReminders / runMpesaRenewals / runRetries / runExpiry —
 *         new exports consumed by cron.routes.ts.
 *         Each is a standalone async function that can be called by the cron
 *         route or directly by a scheduled job.
 */

import {
  PrismaClient,
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

const prisma = new PrismaClient();

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

/**
 * Canonical frontend URL for Stripe redirects.
 * Set FRONTEND_URL=https://flowfit.cctamcc.site in Vercel env vars.
 */
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

/** All active, ordered plans for the pricing page */
export async function getPlans(): Promise<PublicPlan[]> {
  const plans = await prisma.plan.findMany({
    where:   { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  return plans.map(toPublicPlan);
}

/** The user's current (most recent) subscription */
export async function getCurrentSubscription(
  userId: string,
): Promise<CurrentSubscription | null> {
  // Priority order ensures we return the subscription the user actually cares about.
  // Without this, a newer INCOMPLETE checkout record (created after the user's TRIALING
  // sub) would be returned instead of the TRIALING sub, causing the PAYMENT FAILED
  // banner to show for users who have a working subscription.
  const STATUS_PRIORITY: Record<string, number> = {
    ACTIVE:             0,
    TRIALING:           1,
    PAST_DUE:           2,
    GRACE_PERIOD:       3,
    PAUSED:             4,
    INCOMPLETE:         5,
    CANCELLED:          6,
    EXPIRED:            7,
    INCOMPLETE_EXPIRED: 8,
  };

  const allSubs = await prisma.subscription.findMany({
    where:   { userId },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
    take:    10,  // guard against users with many historical records
  });

  if (!allSubs.length) return null;

  // Sort by status priority first, then by createdAt desc as tiebreaker
  const sub = allSubs.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.createdAt.getTime() - a.createdAt.getTime();
  })[0];

  if (!sub) return null;

  let scheduledPlanSlug: string | null = null;
  if (sub.scheduledPlanId) {
    const sp = await prisma.plan.findUnique({
      where:  { id: sub.scheduledPlanId },
      select: { slug: true },
    });
    scheduledPlanSlug = sp?.slug ?? null;
  }

  // FIX-A: stripeSubscriptionId is now part of the CurrentSubscription type.
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
    stripeSubscriptionId: sub.stripeSubscriptionId ?? null,    // FIX-A
  };
}

/**
 * Create a Stripe Checkout Session.
 * successUrl / cancelUrl are forwarded from the frontend request body so
 * Stripe redirects back to the frontend, not the API server.
 */
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

// ─── FIX-B: M-Pesa subscription initiation ────────────────────────────────────

export interface MpesaSubscriptionResult {
  merchantRequestId:  string;
  checkoutRequestId:  string;
  subscriptionId:     string;
  customerMessage:    string;
}

/**
 * FIX-B — createMpesaSubscription
 *
 * Was missing from the service; subscription.routes.ts imports it for
 * POST /mpesa/initiate.
 *
 * 1. Resolves the KES price from the plan (mpesaMonthlyKes / mpesaYearlyKes).
 * 2. Creates a Subscription record (provider=MPESA, status=INCOMPLETE).
 * 3. Fires an STK Push via initiateStkPush from mpesa.service.
 * 4. Creates a MpesaTransaction record to track the attempt.
 * 5. Returns IDs needed by the route handler to respond to the client.
 */
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

  // Normalise phone to 2547XXXXXXXX format required by Daraja
  const phone = normalisePhone(rawPhone);

  // Persist the subscription immediately so we have an ID for the transaction
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
    { planSlug: plan.slug, interval, phone },
  );

  // Build the Daraja callback URL
  const appUrl      = process.env.APP_URL || '';
  const callbackUrl = `${appUrl}/api/webhooks/mpesa/callback`;

  // Initiate STK Push
  const stk = await initiateStkPush(
    phone,
    amountKes,
    `FlowFit-${plan.slug.toUpperCase()}`,
    `FlowFit ${plan.name} ${interval.toLowerCase()}`,
    
  );

  // Record the transaction attempt
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
      timeoutAt:         new Date(Date.now() + 5 * 60 * 1000), // 5-minute window
    },
  });

  // Persist the phone on the user for future renewals
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

// ─── FIX-C: M-Pesa webhook handlers ───────────────────────────────────────────

/**
 * FIX-C — handleMpesaSuccess
 *
 * Was missing from the service; mpesa.webhook.routes.ts imports it.
 * Called when Daraja sends a successful payment callback.
 *
 * 1. Finds the MpesaTransaction by checkoutRequestId.
 * 2. Marks it SUCCESS.
 * 3. Activates the linked Subscription (ACTIVE, period windows set).
 * 4. Logs the event.
 */
export async function handleMpesaSuccess(
  checkoutRequestId: string,
  mpesaReceiptNumber: string,
  amountKes?: number,
): Promise<void> {
  const tx = await prisma.mpesaTransaction.findUnique({
    where:   { checkoutRequestId },
    include: { subscription: { include: { plan: true } } },
  });

  if (!tx) {
    console.warn(`[mpesa] No transaction found for ${checkoutRequestId}`);
    return;
  }

  // Idempotency: already processed
  if (tx.status === 'SUCCESS') return;

  const now  = new Date();
  const plan = tx.subscription?.plan;

  // Billing window: 30 days for MONTHLY, 365 for YEARLY
  const periodDays = tx.subscription?.interval === 'YEARLY' ? 365 : 30;
  const periodEnd  = new Date(now.getTime() + periodDays * 86_400_000);

  await prisma.$transaction(async (db) => {
    // Mark transaction complete
    await db.mpesaTransaction.update({
      where: { id: tx.id },
      data: {
        status:             'SUCCESS',
        mpesaReceiptNumber,
        completedAt:        now,
        resultCode:         '0',
        resultDesc:         'The service request is processed successfully.',
      },
    });

    if (tx.subscriptionId) {
      // Activate the subscription
      await db.subscription.update({
        where: { id: tx.subscriptionId },
        data: {
          status:             'ACTIVE',
          activatedAt:        now,
          currentPeriodStart: now,
          currentPeriodEnd:   periodEnd,
          cancelAtPeriodEnd:  false,
        },
      });

      // Record payment
      await db.payment.create({
        data: {
          subscriptionId:    tx.subscriptionId,
          provider:          'MPESA',
          mpesaTransactionId: tx.id,
          mpesaReceiptNumber,
          amountCents:       Math.round((amountKes ?? tx.amountKes) * 100 / 130), // approx USD cents
          currency:          'KES',
          status:            'succeeded',
        },
      });

      await db.subscriptionLog.create({
        data: {
          subscriptionId: tx.subscriptionId,
          event:          'MPESA_STK_SUCCESS',
          previousStatus: tx.subscription?.status,
          newStatus:      'ACTIVE',
          metadata: {
            checkoutRequestId,
            mpesaReceiptNumber,
            amountKes: amountKes ?? tx.amountKes,
          },
        },
      });
    }
  });
}

/**
 * FIX-C — handleMpesaFailure
 *
 * Was missing from the service; mpesa.webhook.routes.ts imports it.
 * Called when Daraja reports a failed or cancelled payment.
 *
 * Marks the transaction FAILED/CANCELLED, and optionally moves a
 * TRIALING → PAST_DUE if this was a renewal attempt.
 */
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

  // Idempotency: already processed
  if (tx.status !== 'PENDING') return;

  // resultCode 1032 = user cancelled
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
      // Only update subscription status if this was a renewal (not first payment)
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
          metadata: { checkoutRequestId, resultCode, resultDesc },
        },
      });
    }
  });
}

// ─── FIX-D: Cron job functions ─────────────────────────────────────────────────

/**
 * FIX-D — runRenewalReminders
 *
 * Was missing; cron.routes.ts imports it.
 * Finds ACTIVE M-Pesa subscriptions expiring within the reminder window
 * (default: 3 days) and logs a RENEWAL_REMINDER_SENT event.
 * In production wire in an email/SMS notification here.
 */
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

/**
 * FIX-D — runMpesaRenewals
 *
 * Was missing; cron.routes.ts imports it.
 * Finds ACTIVE M-Pesa subscriptions within the renewal window and initiates
 * a fresh STK Push for each. Requires user.mpesaPhone to be set.
 */
export async function runMpesaRenewals(): Promise<{
  processed: number;
  errors:    number;
}> {
  const RENEWAL_WINDOW_HOURS = 24;
  const now                  = new Date();
  const windowEnd            = new Date(
    now.getTime() + RENEWAL_WINDOW_HOURS * 3_600_000,
  );

  const subs = await prisma.subscription.findMany({
    where: {
      provider:            'MPESA',
      status:              { in: ['ACTIVE'] },
      autoRenew:           true,
      currentPeriodEnd:    { lte: windowEnd, gte: now },
      mpesaLastRenewalAt:  null,  // not yet attempted this cycle
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
        console.warn(
          `[cron/renewals] Sub ${sub.id}: no KES price for ${sub.plan.slug}`,
        );
        continue;
      }

      const appUrl      = process.env.APP_URL || '';
      const callbackUrl = `${appUrl}/api/webhooks/mpesa/callback`;

      const stk = await initiateStkPush(
        phone,
        amountKes,
        `FlowFit-${sub.plan.slug.toUpperCase()}`,
        `FlowFit renewal ${sub.plan.name}`,
        
      );

      const attempts = (sub.mpesaRenewalAttempts ?? 0) + 1;

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
            metadata:       { stk: stk.checkoutRequestId, isRenewal: true },
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

/**
 * FIX-D — runRetries
 *
 * Was missing; cron.routes.ts imports it.
 * Finds PAST_DUE M-Pesa subscriptions within the grace period that have not
 * exceeded the retry limit (3 attempts) and fires a new STK Push.
 */
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
      // Only retry while inside grace period
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

      const appUrl      = process.env.APP_URL || '';
      const callbackUrl = `${appUrl}/api/webhooks/mpesa/callback`;

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

/**
 * FIX-D — runExpiry
 *
 * Was missing; cron.routes.ts imports it.
 * Marks subscriptions as EXPIRED when:
 *   - Status is ACTIVE or PAST_DUE
 *   - currentPeriodEnd has passed
 *   - For M-Pesa: gracePeriodEndsAt has also passed (or is null)
 *   - For Stripe: Stripe webhook usually handles this, but we catch stragglers
 */
export async function runExpiry(): Promise<{
  expired: number;
  errors:  number;
}> {
  const now = new Date();

  // Find subscriptions past their period end with no grace period remaining
  const subs = await prisma.subscription.findMany({
    where: {
      status:           { in: ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'] },
      currentPeriodEnd: { lt: now },
      // Grace period: skip MPESA subs that still have time remaining
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
      await logEvent(
        sub.id, 'CANCELLED', prevStatus, 'CANCELLED',
        { reason, immediately: true },
        ipAddress,
      );
    } else {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd:  true,
          cancellationReason: reason,
        },
      });
      await logEvent(
        sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus,
        { reason, atPeriodEnd: true },
        ipAddress,
      );
    }
  } else {
    // DB-only cancel for M-Pesa / abandoned INCOMPLETE checkouts
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:             'CANCELLED',
        cancelledAt:        new Date(),
        cancelAtPeriodEnd:  false,
        cancellationReason: reason ?? 'user_requested_no_stripe_id',
      },
    });
    await logEvent(
      sub.id, 'CANCELLED', prevStatus, 'CANCELLED',
      { reason, immediately, note: 'db_only_no_stripe_sub' },
      ipAddress,
    );
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
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      cancelAtPeriodEnd:  false,
      cancellationReason: null,
    },
  });

  await logEvent(
    sub.id, 'REACTIVATED', sub.status, sub.status,
    { hadStripeId: !!sub.stripeSubscriptionId },
    ipAddress,
  );

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

  if (!sub)    throw new Error('No active subscription to upgrade');
  if (!newPlan) throw new Error('Target plan not found');
  if (!sub.stripeSubscriptionId) {
    throw new Error(
      'M-Pesa upgrades require a new payment. Use /mpesa/initiate with the new plan.',
    );
  }

  const newPriceId = newInterval === 'YEARLY'
    ? newPlan.stripePriceIdYearly
    : newPlan.stripePriceIdMonthly;
  if (!newPriceId) {
    throw new Error(
      `Stripe price not configured for ${newPlan.slug}/${newInterval}`,
    );
  }

  const stripeSub = await stripe.subscriptions.retrieve(
    sub.stripeSubscriptionId,
  );
  const itemId = stripeSub.items.data[0]?.id;
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

  await logEvent(
    sub.id, 'UPGRADED', sub.status, sub.status,
    { fromPlan: prevPlanSlug, toPlan: newPlan.slug, interval: newInterval },
    ipAddress,
  );

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
  if (!newPlan)  throw new Error('Target plan not found');
  if (!sub.stripeSubscriptionId) {
    throw new Error('No Stripe subscription ID — cannot schedule downgrade');
  }

  const newPriceId = newInterval === 'YEARLY'
    ? newPlan.stripePriceIdYearly
    : newPlan.stripePriceIdMonthly;
  if (!newPriceId) {
    throw new Error(
      `Stripe price not configured for ${newPlan.slug}/${newInterval}`,
    );
  }

  const stripeSub = await stripe.subscriptions.retrieve(
    sub.stripeSubscriptionId,
  );
  const itemId = stripeSub.items.data[0]?.id;

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

  await logEvent(
    sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status,
    { fromPlan: sub.plan.slug, toPlan: newPlan.slug, interval: newInterval },
    ipAddress,
  );

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

export { prisma };
