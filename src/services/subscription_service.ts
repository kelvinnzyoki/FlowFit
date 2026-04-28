/**
 * FLOWFIT — Subscription Service (v6)
 *
 * Migration: Stripe → Paystack (v3 → v6).
 *
 * CHANGES FROM v5:
 *   STR→PS-1  Removed all Stripe imports and stripe.* API calls.
 *             Replaced with Paystack equivalents from paystack.service.ts.
 *
 *   STR→PS-2  createCheckoutSession: now calls Paystack transaction/initialize.
 *             Returns { url: authorization_url, reference } instead of
 *             { url: stripeCheckoutUrl, sessionId }.
 *             DB field: stripeCheckoutSessionId → paystackReference.
 *
 *   STR→PS-3  cancelSubscription: Paystack subs are cancelled by calling
 *             POST /subscription/disable with { code, token }.
 *             Both paystackSubscriptionCode AND paystackEmailToken must be
 *             present — if either is missing, falls back to DB-only cancel
 *             (covers M-Pesa subs and incomplete Paystack checkouts).
 *
 *   STR→PS-4  reactivateSubscription: calls POST /subscription/enable with
 *             { code, token } when Paystack codes are available.
 *
 *   STR→PS-5  upgradeSubscription: Paystack has no direct price-swap equivalent
 *             (unlike Stripe's subscription item update). Upgrades for Paystack
 *             subs now initiate a new checkout session; the old subscription is
 *             disabled and the DB record replaced once the new charge succeeds
 *             via the webhook. Throws with a clear message so the route can
 *             redirect the client to /checkout instead of /upgrade.
 *
 *   STR→PS-6  scheduleDowngrade: previously called stripe.subscriptions.update
 *             to set metadata. Now DB-only — Paystack does not support metadata
 *             on scheduled plan changes. The scheduled change is stored in DB
 *             and applied by the cron job or webhook handler on period end.
 *
 *   STR→PS-7  getBillingPortalUrl: Paystack has no hosted billing portal.
 *             Returns the frontend subscription management page URL so the
 *             client can redirect there instead of opening a Paystack-hosted UI.
 *
 *   STR→PS-8  getCurrentSubscription: returns paystackSubscriptionCode +
 *             paystackEmailToken instead of stripeSubscriptionId.
 *
 *   STR→PS-9  getFrontendUrl warning: updated to mention Paystack.
 *
 * M-Pesa fixes carried over from v5 (unchanged):
 *   NEW-R1  handleMpesaSuccess: clear gracePeriodEndsAt + reset mpesaRenewalAttempts.
 *   NEW-R2  handleMpesaFailure: map 1032/1037 to CANCELLED/TIMEOUT; grace period on failure.
 *   NEW-R3  runExpiry: skip sub if recent SUCCESS mpesaTransaction exists.
 *   NEW-R4  createMpesaSubscription: block cross-provider duplicate active subscriptions.
 *   NEW-R5  runReconciliation: scan M-Pesa SUCCESS txns and fix drift.
 *   NEW-R6  runMpesaRenewals / runRetries: set gracePeriodEndsAt on STK initiation.
 */

import {
  SubscriptionStatus,
  BillingInterval,
  SubscriptionEvent,
} from '@prisma/client';
import type { PublicPlan, CurrentSubscription } from '../types/subscription.types.js';
import {
  initializeTransaction,
  disableSubscription  as paystackDisable,
  enableSubscription   as paystackEnable,
  getOrCreatePaystackCustomer,
} from './paystack.service.js';
import {
  initiateStkPush,
  normalisePhone,
} from './mpesa.service.js';
import prisma from '../config/db.js';

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
      'Paystack redirects will be broken.',
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

  // STR→PS-8: return Paystack subscription codes instead of stripeSubscriptionId
  return {
    id:                      sub.id,
    status:                  sub.status,
    interval:                sub.interval,
    plan:                    toPublicPlan(sub.plan),
    trialEndsAt:             sub.trialEndsAt?.toISOString()        ?? null,
    currentPeriodStart:      sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd:        sub.currentPeriodEnd?.toISOString()   ?? null,
    cancelAtPeriodEnd:       sub.cancelAtPeriodEnd,
    cancelledAt:             sub.cancelledAt?.toISOString()        ?? null,
    scheduledPlanSlug,
    activatedAt:             sub.activatedAt?.toISOString()        ?? null,
    daysUntilRenewal:        daysUntil(sub.currentPeriodEnd),
    paystackSubscriptionCode: sub.paystackSubscriptionCode ?? null,
    paystackEmailToken:       sub.paystackEmailToken       ?? null,
  };
}

// ─── STR→PS-2: Paystack checkout (replaces Stripe checkout session) ───────────
//
// Flow:
//   1. Resolve the Paystack plan code for the chosen interval.
//   2. Ensure a Paystack customer code exists for the user (getOrCreatePaystackCustomer).
//   3. Call Paystack POST /transaction/initialize — returns authorization_url + reference.
//   4. Create an INCOMPLETE subscription row with paystackReference (= transaction ref).
//   5. Return { url: authorization_url, reference } to the caller.
//
// On successful payment Paystack fires a `charge.success` webhook (handled in
// webhook_routes.ts). That handler activates the subscription, stores
// paystackSubscriptionCode + paystackEmailToken from the webhook payload, and
// updates the paystackCustomerCode on the User row.
//
export async function createCheckoutSession(
  userId:      string,
  email:       string,
  name:        string | null | undefined,
  planId:      string,
  interval:    BillingInterval,
  successUrl?: string,
  cancelUrl?:  string,
): Promise<{ authorizationUrl: string; reference: string; accessCode: string }> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan)          throw new Error('Plan not found');
  if (!plan.isActive) throw new Error('Plan is no longer available');

  // Paystack plan codes (set up in your Paystack dashboard + stored in DB)
  const paystackPlanCode = interval === 'YEARLY'
    ? plan.paystackPlanCodeYearly
    : plan.paystackPlanCodeMonthly;

  if (!paystackPlanCode) {
    throw new Error(
      `Paystack plan not configured for plan "${plan.slug}" / ${interval}`,
    );
  }

  // NEW-R4: Block if the user already has an active or trialing subscription
  // from ANY provider. Without this, a Paystack checkout could run while an
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
  const resolvedSuccessUrl = successUrl || `${base}/subscription.html?success=1`;
  const resolvedCancelUrl  = cancelUrl  || `${base}/subscription.html?cancelled=1`;

  // Ensure a Paystack customer code exists for the user
  const paystackCustomerCode = await getOrCreatePaystackCustomer(
    prisma, userId, email, name,
  );

  // Paystack transaction/initialize — the plan code makes it a recurring subscription
  const txn = await initializeTransaction({
    email,
    amount:       interval === 'YEARLY' ? plan.yearlyPriceCents : plan.monthlyPriceCents,
    // Paystack amounts are in the smallest currency unit (kobo for NGN, cents for USD/KES).
    // Verify your Paystack dashboard currency matches; KES on Paystack is in cents.
    currency:     'KES',
    plan:         paystackPlanCode,
    callback_url: resolvedSuccessUrl,
    metadata: {
      userId,
      planId,
      interval,
      cancelUrl:              resolvedCancelUrl,
      existingSubscriptionId: existing?.id ?? '',
      // Trial: only offered when no prior sub exists
      trialDays: plan.trialDays > 0 && !existing ? plan.trialDays : 0,
    },
  });

  const pendingSub = await prisma.subscription.create({
    data: {
      userId,
      planId,
      status:           'INCOMPLETE',
      interval,
      paystackReference: txn.reference,   // echoed back in charge.success webhook
      paystackCustomerCode,
      trialStartedAt: plan.trialDays > 0 && !existing ? new Date() : null,
      trialEndsAt:    plan.trialDays > 0 && !existing
        ? new Date(Date.now() + plan.trialDays * 86_400_000)
        : null,
    },
  });

  await logEvent(pendingSub.id, 'CREATED', null, 'INCOMPLETE', {
    planSlug:  plan.slug,
    interval,
    reference: txn.reference,
  });

  return {
    authorizationUrl: txn.authorization_url,
    reference:        txn.reference,
    accessCode:       (txn as any).access_code ?? '',
  };
}

// ─── M-Pesa subscription initiation ──────────────────────────────────────────
// (unchanged from v5 — M-Pesa flow is provider-independent)

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
  const activeAnySub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (activeAnySub) {
    throw new Error(
      `User already has an ${activeAnySub.status} ${activeAnySub.provider} subscription. ` +
      'Cancel or upgrade the existing subscription first.',
    );
  }

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
// (unchanged from v5)

export async function handleMpesaSuccess(
  checkoutRequestId:  string,
  mpesaReceiptNumber: string,
  amountKes?:         number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const mpesaTx = await tx.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
      include: { subscription: true },
    });

    if (!mpesaTx || !mpesaTx.subscription) {
      throw new Error(`Transaction ${checkoutRequestId} not found`);
    }

    if (mpesaTx.status === 'SUCCESS') {
      console.log(`[handleMpesaSuccess] Already processed: ${checkoutRequestId}`);
      return;
    }

    const subscription = mpesaTx.subscription;
    const now = new Date();
    const isRenewal = mpesaTx.isRenewal === true;

    let newPeriodEnd: Date;
    if (subscription.interval === 'YEARLY') {
      newPeriodEnd = new Date(now);
      newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
    } else {
      newPeriodEnd = new Date(now);
      newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    }

    await tx.mpesaTransaction.update({
      where: { checkoutRequestId },
      data: {
        status:             'SUCCESS',
        mpesaReceiptNumber,
        completedAt:        now,
      },
    });

    await tx.payment.create({
      data: {
        subscriptionId:    subscription.id,
        mpesaReceiptNumber,
        amountCents:       (amountKes ?? 0) * 100,
        currency:          'KES',
        status:            'succeeded',
        provider:          'MPESA',
      },
    });

    // NEW-R1: Always clear gracePeriodEndsAt and reset mpesaRenewalAttempts.
    const prevStatus = subscription.status;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status:               'ACTIVE',
        currentPeriodStart:   now,
        currentPeriodEnd:     newPeriodEnd,
        activatedAt:          prevStatus !== 'ACTIVE' ? now : undefined,
        mpesaLastRenewalAt:   isRenewal ? now : undefined,
        gracePeriodEndsAt:    null,
        mpesaRenewalAttempts: 0,
      },
    });

    await tx.subscriptionLog.create({
      data: {
        subscriptionId: subscription.id,
        event:          isRenewal ? 'PAYMENT_SUCCEEDED' : 'MPESA_STK_SUCCESS',
        previousStatus: prevStatus,
        newStatus:      'ACTIVE',
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

  if (tx.status !== 'PENDING') return;

  // NEW-R2: Map result codes to meaningful states.
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
        // NEW-R2: Set grace period so user keeps access during retry window.
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
          metadata: {
            checkoutRequestId,
            resultCode,
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
// (unchanged from v5)

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
  const renewalCutoff        = new Date(now.getTime() - 23 * 3_600_000);

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
            // NEW-R6: Grace period from STK initiation — user keeps access while awaiting callback.
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
            // NEW-R6: Extend grace period while retry STK is pending.
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
      // Only expire MPESA subscriptions here. Paystack-managed subscriptions are
      // controlled by Paystack charge.success / subscription.disable webhooks.
      // Running this job on Paystack subs risks expiring a subscription seconds
      // before Paystack's renewal webhook arrives.
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
      // NEW-R3: Skip if a recent SUCCESS mpesaTransaction exists (webhook race guard).
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

// ─── STR→PS-3: Cancel subscription ───────────────────────────────────────────
//
// Paystack subs are cancelled by calling POST /subscription/disable.
// Both paystackSubscriptionCode AND paystackEmailToken must be present —
// if either is missing the subscription is cancelled DB-only
// (covers M-Pesa subs and incomplete/abandoned Paystack checkouts).
//
// Paystack does not support "cancel at period end" as a first-class API concept
// (unlike Stripe's cancel_at_period_end flag). We implement it DB-only:
//   - immediately=false: set cancelAtPeriodEnd=true, leave the Paystack
//     subscription active. A cron job (or the charge.success webhook) will
//     call /subscription/disable when currentPeriodEnd is reached.
//   - immediately=true: call /subscription/disable NOW, then update DB.
//
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
  const hasPaystackSub =
    !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken;

  if (hasPaystackSub) {
    if (immediately) {
      // Disable the Paystack subscription immediately — stops future charges.
      await paystackDisable(
        sub.paystackSubscriptionCode!,
        sub.paystackEmailToken!,
      );
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
      // "Cancel at period end" — Paystack's /subscription/disable sets the
      // subscription to non-renewing: the user keeps access until currentPeriodEnd
      // and Paystack will not charge again. Without this API call, Paystack has no
      // knowledge of the cancellation intent and WILL keep charging the user.
      await paystackDisable(
        sub.paystackSubscriptionCode!,
        sub.paystackEmailToken!,
      );
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
    // M-Pesa sub or incomplete Paystack checkout — DB-only cancel.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:             'CANCELLED',
        cancelledAt:        new Date(),
        cancelAtPeriodEnd:  false,
        cancellationReason: reason ?? 'user_requested_no_paystack_sub',
      },
    });
    await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', {
      reason, immediately,
      note: 'db_only_no_paystack_sub',
    }, ipAddress);
  }

  return (await getCurrentSubscription(userId))!;
}

// ─── STR→PS-4: Reactivate (undo cancel-at-period-end) ────────────────────────
//
// If Paystack codes exist we call /subscription/enable to ensure the
// subscription is active on the Paystack side. Also clears cancelAtPeriodEnd.
//
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

  const hasPaystackSub =
    !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken;

  if (hasPaystackSub) {
    await paystackEnable(
      sub.paystackSubscriptionCode!,
      sub.paystackEmailToken!,
    );
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
    { hadPaystackSub: hasPaystackSub },
    ipAddress,
  );

  return (await getCurrentSubscription(userId))!;
}

// ─── STR→PS-5: Upgrade subscription ──────────────────────────────────────────
//
// Paystack has no direct plan price-swap equivalent (unlike Stripe's
// subscription item update). Paystack upgrades must go through a new
// transaction/initialize call with the new plan code.
//
// This function handles the DB side of a confirmed Paystack upgrade:
//   - The old subscription's paystackSubscriptionCode is disabled via API.
//   - The DB subscription row is updated to the new plan and status.
//   - Called from the webhook handler once the new charge.success arrives,
//     OR from the route directly when the client confirms an upgrade intent.
//
// For the checkout redirect flow (initiate), routes should call
// createCheckoutSession with the new plan — this function handles post-payment.
//
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

  const hasPaystackSub =
    !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken;

  if (hasPaystackSub) {
    // Paystack does not support mid-cycle plan swaps via API.
    // Signal to the route/client that a new checkout is required.
    // The client should call createCheckoutSession with newPlanId, which
    // creates a new INCOMPLETE sub. On charge.success, the webhook disables
    // the old Paystack subscription and activates the new one.
    throw new Error(
      'PAYSTACK_NEW_CHECKOUT_REQUIRED: Paystack upgrades require a new payment. ' +
      `Use /subscriptions/checkout with planId=${newPlanId}. ` +
      'The existing subscription will be cancelled once the new payment succeeds.',
    );
  }

  // M-Pesa sub upgrade — DB-only (M-Pesa has no subscription management API).
  // The new plan takes effect immediately; user starts a new M-Pesa payment flow.
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
    { fromPlan: prevPlanSlug, toPlan: newPlan.slug, interval: newInterval, note: 'mpesa_db_only' },
    ipAddress,
  );

  return (await getCurrentSubscription(userId))!;
}

// ─── STR→PS-6: Schedule downgrade ────────────────────────────────────────────
//
// Paystack does not support metadata on scheduled plan changes (no equivalent
// of stripe.subscriptions.update with metadata). The scheduled change is stored
// in DB only. Applied by the cron job or charge.success webhook on period end.
//
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

  // DB-only: store the scheduled plan. A cron job applies it at period end.
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      scheduledPlanId:   newPlanId,
      scheduledInterval: newInterval,
    },
  });

  await logEvent(
    sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status,
    { fromPlan: sub.plan.slug, toPlan: newPlan.slug, interval: newInterval, note: 'db_only_paystack' },
    ipAddress,
  );

  return (await getCurrentSubscription(userId))!;
}

// ─── STR→PS-7: Billing portal ────────────────────────────────────────────────
//
// Paystack has no hosted billing / customer portal equivalent.
// Return the frontend subscription management page URL so the client
// can navigate there for plan changes, cancellation, and payment history.
//
export async function getBillingPortalUrl(userId: string): Promise<string> {
  const frontendBase = getFrontendUrl();
  // Optionally append ?manage=1 so the frontend can auto-scroll to the
  // management section or show a "Welcome back" prompt.
  return `${frontendBase}/subscription.html?manage=1`;
}


// ─── Alias for subscription.routes.ts ────────────────────────────────────────
// routes import createPaystackCheckout; service implements as createCheckoutSession
export const createPaystackCheckout = createCheckoutSession;

// FIX-H4: Export the singleton so existing importers keep working.
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
 * Any drift found is fixed atomically inside a transaction and logged.
 * Run daily via POST /internal/cron/reconcile.
 *
 * TODO: wire up an email/Slack alert when driftCount > 0.
 */
export async function runReconciliation(): Promise<{
  checked: number;
  fixed:   number;
  errors:  number;
}> {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const now   = new Date();

  const txns = await prisma.mpesaTransaction.findMany({
    where: {
      status:         'SUCCESS',
      completedAt:    { gte: since },
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
    if (!sub) continue;

    try {
      const paymentExists = tx.mpesaReceiptNumber
        ? await prisma.payment.findFirst({
            where: { mpesaReceiptNumber: tx.mpesaReceiptNumber },
          })
        : null;

      const subIsHealthy =
        sub.status === 'ACTIVE' &&
        sub.currentPeriodEnd != null &&
        sub.currentPeriodEnd > now;

      if (paymentExists && subIsHealthy) continue;

      console.warn(
        `[reconcile] DRIFT detected — tx ${tx.id} ` +
        `receipt ${tx.mpesaReceiptNumber ?? 'N/A'} | ` +
        `sub ${sub.id} status=${sub.status} ` +
        `periodEnd=${sub.currentPeriodEnd?.toISOString() ?? 'null'} | ` +
        `paymentRecord=${paymentExists ? 'EXISTS' : 'MISSING'}`,
      );

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
        if (!paymentExists && tx.mpesaReceiptNumber) {
          await db.payment.create({
            data: {
              subscriptionId:     sub.id,
              mpesaReceiptNumber: tx.mpesaReceiptNumber,
              amountCents:        (tx.amountKes ?? 0) * 100,
              currency:           'KES',
              status:             'succeeded',
              provider:           'MPESA',
            },
          });
        }

        if (!subIsHealthy) {
          await db.subscription.update({
            where: { id: sub.id },
            data: {
              status:               'ACTIVE',
              currentPeriodStart:   tx.completedAt ?? now,
              currentPeriodEnd:     repairedPeriodEnd,
              gracePeriodEndsAt:    null,
              mpesaRenewalAttempts: 0,
              activatedAt:          sub.activatedAt ?? now,
            },
          });
        }

        await db.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'PAYMENT_SUCCEEDED',
            previousStatus: sub.status as any,
            newStatus:      'ACTIVE',
            metadata: {
              reconciled:        true,
              txId:              tx.id,
              receiptNumber:     tx.mpesaReceiptNumber,
              missingPayment:    !paymentExists,
              statusWas:         sub.status,
              repairedPeriodEnd: repairedPeriodEnd.toISOString(),
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
