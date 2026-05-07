/**
 * FLOWFIT — Subscription Service (v7 — Paystack Fixed)
 */

import {
  SubscriptionStatus,
  BillingInterval,
  SubscriptionEvent,
} from '@prisma/client';
import type { PublicPlan, CurrentSubscription } from '../types/subscription.types.js';
import {
  initializeTransaction,
  disableSubscription    as paystackDisable,
  enableSubscription     as paystackEnable,
  fetchPaystackSubscription,
  findPaystackSubscriptionByCustomer,
  getOrCreatePaystackCustomer,
  generatePaystackManageLink,
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
  if (!plan) {
    return {
      id: '',
      slug: 'pro' as const,           // Fixed: must be valid PlanSlug
      name: 'Unknown Plan',
      description: null,
      monthlyPriceCents: 0,
      yearlyPriceCents: 0,
      trialDays: 0,
      maxWorkoutsPerMonth: null,
      maxPrograms: null,
      hasAdvancedAnalytics: false,
      hasPersonalCoaching: false,
      hasNutritionTracking: false,
      hasOfflineAccess: false,
      features: [],
      displayOrder: 0,
      isPopular: false,
    };
  }

  return {
    id:                   plan.id || '',
    slug:                 (plan.slug as any) || 'pro',   // safe cast
    name:                 plan.name || 'Unknown Plan',
    description:          plan.description || null,
    monthlyPriceCents:    plan.monthlyPriceCents || 0,
    yearlyPriceCents:     plan.yearlyPriceCents || 0,
    trialDays:            plan.trialDays || 0,
    maxWorkoutsPerMonth:  plan.maxWorkoutsPerMonth ?? null,
    maxPrograms:          plan.maxPrograms ?? null,
    hasAdvancedAnalytics: plan.hasAdvancedAnalytics ?? false,
    hasPersonalCoaching:  plan.hasPersonalCoaching ?? false,
    hasNutritionTracking: plan.hasNutritionTracking ?? false,
    hasOfflineAccess:     plan.hasOfflineAccess ?? false,
    features:             Array.isArray(plan.features)
                            ? plan.features
                            : typeof plan.features === 'string'
                              ? JSON.parse(plan.features || '[]')
                              : [],
    displayOrder:         plan.displayOrder || 0,
    isPopular:            plan.isPopular ?? false,
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
  try {
    await prisma.subscriptionLog.create({
      data: {
        subscriptionId,
        event,
        previousStatus: previousStatus ?? undefined,
        newStatus:      newStatus ?? undefined,
        metadata:       metadata as any,
        ipAddress,
      },
    });
  } catch (err) {
    console.error(`[logEvent] Failed for sub ${subscriptionId}:`, err);
  }
}

function getFrontendUrl(): string {
  // FRONTEND_URL must be the user-facing web app (e.g. https://flowfit.cctamcc.site).
  // Never fall back to APP_URL — that is the API server domain. Using the API
  // domain as the Paystack callback_url means Paystack redirects the user to the
  // API server (which has no subscription.html), the ?reference= param is lost,
  // and the subscription stays INCOMPLETE forever.
  const url = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  if (!url) {
    console.warn(
      '[subscription.service] FRONTEND_URL is not set. ' +
      'Paystack callback_url fallback will be empty — users will not be redirected ' +
      'back to the app after payment. Set FRONTEND_URL=https://flowfit.cctamcc.site ' +
      'in Vercel → Settings → Environment Variables.',
    );
  }
  return url;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getPlans(): Promise<PublicPlan[]> {
  try {
    const plans = await prisma.plan.findMany({
      where:   { isActive: true },
      orderBy: { displayOrder: 'asc' },
    });
    return plans.map(toPublicPlan);
  } catch (err) {
    console.error('[getPlans] Error:', err);
    return [];
  }
}

export async function getCurrentSubscription(
  userId: string,
): Promise<CurrentSubscription | null> {
  try {
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
    if (!sub) return null;

    // Defensive plan handling
    const planData = sub.plan || await prisma.plan.findUnique({ where: { id: sub.planId } });
    const plan = toPublicPlan(planData);

    let scheduledPlanSlug: string | null = null;
    if (sub.scheduledPlanId) {
      const sp = await prisma.plan.findUnique({
        where: { id: sub.scheduledPlanId },
        select: { slug: true },
      });
      scheduledPlanSlug = sp?.slug ?? null;
    }

    return {
      id:                      sub.id,
      status:                  sub.status,
      interval:                sub.interval,
      plan,
      trialEndsAt:             sub.trialEndsAt?.toISOString() ?? null,
      currentPeriodStart:      sub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd:        sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd:       sub.cancelAtPeriodEnd ?? false,
      cancelledAt:             sub.cancelledAt?.toISOString() ?? null,
      scheduledPlanSlug,
      activatedAt:             sub.activatedAt?.toISOString() ?? null,
      daysUntilRenewal:        daysUntil(sub.currentPeriodEnd),
      paystackSubscriptionCode: sub.paystackSubscriptionCode ?? null,
      paystackEmailToken:       sub.paystackEmailToken ?? null,
    };
  } catch (err: any) {
    console.error('[getCurrentSubscription] Error for user', userId, err);
    return null;
  }
}

// ─── Create Checkout Session ──────────────────────────────────────────────────
export async function createCheckoutSession(
  userId:      string,
  email:       string,
  name:        string | null | undefined,
  planId:      string,
  interval:    BillingInterval,
  successUrl?: string,
  cancelUrl?:  string,
): Promise<{ authorizationUrl: string; reference: string; accessCode: string }> {
  const plan = await prisma.plan.findUnique({ 
    where: { id: planId } 
  });

  if (!plan) throw new Error('Plan not found');
  if (!plan.isActive) throw new Error('Plan is no longer available');

  // BUG-FIX [SS-AMOUNT]: monthlyPriceCents / yearlyPriceCents hold the old
  // Stripe USD price in cents (e.g. 1499 = $14.99). Paystack receives that
  // value with currency:'KES' and interprets it as KES 14.99 — below the
  // realistic minimum for card payments in Kenya, causing "No active channel".
  //
  // mpesaMonthlyKes / mpesaYearlyKes hold the correct KES shilling amount
  // (e.g. 1950 = KES 1,950). Paystack expects the amount in the smallest
  // currency unit (KES cents), so multiply by 100.
  const amountKes = interval === 'YEARLY'
    ? (plan as any).mpesaYearlyKes
    : (plan as any).mpesaMonthlyKes;

  if (!amountKes || amountKes <= 0) {
    throw new Error(
      `KES price not configured for plan "${plan.slug}" / ${interval}. ` +
      `Set mpesaMonthlyKes / mpesaYearlyKes on the plan row in the DB.`,
    );
  }

  // Paystack API amount must be in the smallest currency unit (KES cents).
  const amount = amountKes * 100;

  const paystackPlanCode = interval === 'YEARLY'
    ? (plan as any).paystackPlanCodeYearly
    : (plan as any).paystackPlanCodeMonthly;

  // BUG-FIX [SS-PLANCODE]: Silently falling through as a one-time charge when
  // paystackPlanCode is null means Paystack cannot set up recurring billing and
  // may reject the transaction with "No active channel". Throw early with a
  // clear message so the missing plan code is immediately visible in logs.
  if (!paystackPlanCode) {
    throw new Error(
      `Paystack plan code not set for plan "${plan.slug}" / ${interval}. ` +
      `Create a plan in the Paystack dashboard and update paystackPlanCode` +
      `${interval === 'YEARLY' ? 'Yearly' : 'Monthly'} on the plans row.`,
    );
  }

  // Block duplicate active subscriptions
  const activeAnySub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (activeAnySub) {
    throw new Error(
      `User already has an ${activeAnySub.status} ${activeAnySub.provider} subscription. ` +
      'Cancel or upgrade the existing subscription first.'
    );
  }

  const existing = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
  });

  const base = getFrontendUrl();
  // Fallback uses subscription.html — must match the actual file name served.
  // The frontend's callbackUrl also uses .html; these must be consistent.
  // Paystack appends ?reference=xxx&trxref=xxx to whichever URL is used.
  const resolvedSuccessUrl = successUrl || `${base}/subscription.html?success=1`;
  const resolvedCancelUrl  = cancelUrl  || `${base}/subscription.html?cancelled=1`;

  const paystackCustomerCode = await getOrCreatePaystackCustomer(
    prisma, userId, email, name
  );

  // FIX-CODES-1: Create the INCOMPLETE row BEFORE calling initializeTransaction
  // so we can embed subscriptionId in the Paystack metadata. This is the most
  // reliable way for the charge.success and subscription.create webhooks to find
  // the right DB row — even when email lookup or reference matching fails.
  // Previously the row was created AFTER txn init, making subscriptionId unavailable
  // in metadata, which meant the webhook had to rely on brittle email/reference lookups.
  // Avoid multiple unresolved Paystack checkouts for the same user/plan/interval.
  // Old INCOMPLETE rows without codes are abandoned before a fresh Paystack transaction is initialized.
  await prisma.subscription.updateMany({
    where: {
      userId,
      provider: 'PAYSTACK',
      status: 'INCOMPLETE',
      planId,
      interval,
    },
    data: { status: 'CANCELLED', cancelledAt: new Date(), autoRenew: false },
  });

  const pendingSub = await prisma.subscription.create({
    data: {
      userId,
      planId,
      status:              'INCOMPLETE',
      interval,
      provider:            'PAYSTACK',
      paystackCustomerCode,              // ← CRITICAL: webhook Strategy 0 relies on this
      cancelAtPeriodEnd:   false,
      autoRenew:           true,
      trialStartedAt: plan.trialDays > 0 && !existing ? new Date() : null,
      trialEndsAt: plan.trialDays > 0 && !existing
        ? new Date(Date.now() + plan.trialDays * 86_400_000)
        : null,
    },
  });

  let txn: Awaited<ReturnType<typeof initializeTransaction>>;
  try {
    txn = await initializeTransaction({
      email,
      amount,                         // KES cents (mpesaMonthlyKes * 100)
      currency: 'KES',
      // Paystack subscription strategy:
      // Pass the Paystack plan_code during initialization so Paystack creates
      // the real recurring subscription for the selected app plan. This is
      // critical: removing `plan` downgrades checkout into a one-time card
      // charge and breaks the subscription lifecycle. The verify/reconcile
      // code still has a guarded fallback that can create the remote Paystack
      // subscription from authorization_code only if Paystack has not already
      // produced subscription_code/email_token.
      plan: paystackPlanCode,
      channels: ['card'],             // explicit: only card because subscriptions need reusable authorization
      callback_url: resolvedSuccessUrl,
      metadata: {
        userId,
        planId,
        interval,
        customerCode: paystackCustomerCode,
        // FIX-CODES-1: subscriptionId is now included so webhooks can do a
        // direct DB lookup by ID — the most reliable lookup strategy available.
        subscriptionId:         pendingSub.id,
        existingSubscriptionId: existing?.id ?? '',
        trialDays: plan.trialDays > 0 && !existing ? plan.trialDays : 0,
        planSlug:  plan.slug,
        paystackPlanCode,
      },
    });
  } catch (initErr) {
    // Roll back the INCOMPLETE row so it doesn't litter the DB if Paystack rejects the init.
    await prisma.subscription.delete({ where: { id: pendingSub.id } }).catch(() => {});
    throw initErr;
  }

  // Backfill the reference now that we have it from Paystack.
  await prisma.subscription.update({
    where: { id: pendingSub.id },
    data:  { paystackReference: txn.reference },
  });

  await logEvent(pendingSub.id, 'CREATED', null, 'INCOMPLETE', {
    planSlug: plan.slug,
    interval,
    reference: txn.reference,
  });

  return {
    authorizationUrl: txn.authorization_url,
    reference: txn.reference,
    accessCode: (txn as any).access_code ?? '',
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

  let emailToken = sub.paystackEmailToken;
  if (sub.provider === 'PAYSTACK' && sub.paystackSubscriptionCode && !emailToken) {
    try {
      const psSub = await fetchPaystackSubscription(sub.paystackSubscriptionCode);
      emailToken  = psSub.email_token ?? null;
      if (emailToken) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data:  { paystackEmailToken: emailToken },
        }).catch(() => {/* non-critical — persist for future calls */});
      }
    } catch (err) {
      console.error('[cancelSubscription] Could not fetch emailToken from Paystack:', err);
    }
  }

  const hasPaystackSub = sub.provider === 'PAYSTACK'
    && !!sub.paystackSubscriptionCode
    && !!emailToken;
 
  if (hasPaystackSub) {
    if (immediately) {
      // Immediate cancel: disable on Paystack now and set CANCELLED in DB.
      // Paystack also fires subscription.disable webhook as confirmation.
      await paystackDisable(sub.paystackSubscriptionCode!, emailToken!);
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
      await paystackDisable(sub.paystackSubscriptionCode!, emailToken!).catch(err => {
        // Non-fatal: if Paystack API fails, DB still reflects cancellation intent.
        console.error('[cancelSubscription] paystackDisable failed (period-end):', err);
      });
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd:  true,
          autoRenew:          false,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus, { reason, atPeriodEnd: true }, ipAddress);
    }
  } else {
    if (immediately) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status:             'CANCELLED',
          cancelledAt:        new Date(),
          cancelAtPeriodEnd:  false,
          cancellationReason: reason ?? 'user_requested',
        },
      });
      await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', { reason, immediately: true, note: 'db_only' }, ipAddress);
    } else {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd:  true,
          autoRenew:          false,
          cancellationReason: reason ?? 'user_requested',
        },
      });

      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus, { reason, atPeriodEnd: true, note: 'db_only' }, ipAddress);
    }
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
 
  let subscriptionCode = sub.paystackSubscriptionCode;
  let emailToken = sub.paystackEmailToken;

  // Paystack trials and DB-only subscriptions have no remote subscription to enable.
  // Paid Paystack subscriptions must not silently reactivate in the DB while Paystack
  // remains disabled. Recover a missing emailToken/code by querying existing Paystack
  // subscriptions for this customer; never create a new remote subscription here.
  if (sub.provider === 'PAYSTACK' && (!subscriptionCode || !emailToken) && sub.paystackCustomerCode) {
    const plan = await prisma.plan.findUnique({ where: { id: sub.planId } });
    const planCode = sub.interval === 'YEARLY'
      ? (plan as any)?.paystackPlanCodeYearly
      : (plan as any)?.paystackPlanCodeMonthly;
    const found = await findPaystackSubscriptionByCustomer(sub.paystackCustomerCode, planCode).catch(() => null);
    if (found?.subscription_code && found?.email_token) {
      subscriptionCode = found.subscription_code;
      emailToken = found.email_token;
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          paystackSubscriptionCode: subscriptionCode,
          paystackEmailToken: emailToken,
        },
      });
    }
  }

  const hasPaystackSub = !!subscriptionCode && !!emailToken;
 
  if (sub.provider === 'PAYSTACK' && sub.paystackReference && !hasPaystackSub) {
    throw new Error('Cannot reactivate Paystack subscription because subscription_code/email_token are missing. Run /subscriptions/paystack/fetch-codes first.');
  }

  if (hasPaystackSub) {
    await paystackEnable(subscriptionCode!, emailToken!);
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
    { hadPaystackSub: hasPaystackSub, recoveredPaystackCodes: hasPaystackSub && (!sub.paystackSubscriptionCode || !sub.paystackEmailToken) },
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
 
  if (!sub)     throw new Error('No active subscription to upgrade');
  if (!newPlan) throw new Error('Target plan not found');
  const hasPaystackSub =
    !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken;
 
  if (hasPaystackSub) {
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

export async function getBillingPortalUrl(userId: string): Promise<string> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      provider: 'PAYSTACK',
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD'] },
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (!sub) throw new Error('No Paystack subscription found');
  if (!sub.paystackSubscriptionCode) {
    throw new Error('Paystack subscription code is missing. Run /subscriptions/paystack/fetch-codes first.');
  }

  return generatePaystackManageLink(sub.paystackSubscriptionCode);
}


export const createPaystackCheckout = createCheckoutSession;
 
// FIX-H4: Export the singleton so existing importers keep working.
export { prisma };

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
  
