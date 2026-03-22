/**
 * FLOWFIT — Subscription Service (v2)
 *
 * Fixes vs v1:
 *  1. createCheckoutSession — accept successUrl/cancelUrl params; use FRONTEND_URL
 *     so Stripe redirects to the frontend, not the API server (was the 404 bug).
 *  2. cancelSubscription    — handle missing stripeSubscriptionId (M-Pesa and
 *     INCOMPLETE Stripe subs) with a DB-only cancel instead of throwing.
 *  3. reactivateSubscription — same: handle missing stripeSubscriptionId.
 *  4. getBillingPortalUrl   — use FRONTEND_URL for return_url, not APP_URL.
 */

import {
  PrismaClient,
  SubscriptionStatus,
  BillingInterval,
  SubscriptionEvent,
} from '@prisma/client';
import type { PublicPlan, CurrentSubscription } from '../types/subscription.types.js';
import { stripe, getOrCreateStripeCustomer } from './stripe.service.js';
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
  event: SubscriptionEvent,
  previousStatus: SubscriptionStatus | null | undefined,
  newStatus: SubscriptionStatus | null | undefined,
  metadata: Record<string, unknown> = {},
  ipAddress?: string,
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
 * Resolve the correct frontend URL for Stripe redirects.
 *
 * Priority:
 *  1. FRONTEND_URL env var  — explicit frontend origin (preferred)
 *  2. APP_URL env var       — legacy; may be the API server
 *
 * Set FRONTEND_URL=https://flowfit.cctamcc.site in your Vercel env vars
 * so that Stripe always redirects back to the frontend, not the API server.
 */
function getFrontendUrl(): string {
  const url = process.env.FRONTEND_URL || process.env.APP_URL || '';
  if (!url) {
    console.warn('[subscription.service] Neither FRONTEND_URL nor APP_URL is set — Stripe redirects will be broken.');
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
  const sub = await prisma.subscription.findFirst({
    where:   { userId },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  if (!sub) return null;

  let scheduledPlanSlug: string | null = null;
  if (sub.scheduledPlanId) {
    const sp = await prisma.plan.findUnique({
      where:  { id: sub.scheduledPlanId },
      select: { slug: true },
    });
    scheduledPlanSlug = sp?.slug ?? null;
  }

  return {
    id:                 sub.id,
    status:             sub.status,
    interval:           sub.interval,
    plan:               toPublicPlan(sub.plan),
    trialEndsAt:        sub.trialEndsAt?.toISOString()        ?? null,
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd:   sub.currentPeriodEnd?.toISOString()   ?? null,
    cancelAtPeriodEnd:  sub.cancelAtPeriodEnd,
    cancelledAt:        sub.cancelledAt?.toISOString()        ?? null,
    scheduledPlanSlug,
    activatedAt:        sub.activatedAt?.toISOString()        ?? null,
    daysUntilRenewal:   daysUntil(sub.currentPeriodEnd),
    // Expose whether this is a Stripe-managed sub so routes can branch on it
    stripeSubscriptionId: sub.stripeSubscriptionId ?? null,
  };
}

/**
 * FIX 1 — Create a Stripe Checkout Session.
 *
 * Added: successUrl, cancelUrl parameters.
 * Stripe redirects to these after payment / on cancel.
 *
 * Priority for redirect URLs:
 *   1. successUrl / cancelUrl passed from the frontend (most correct)
 *   2. FRONTEND_URL env var + /subscription.html
 *   3. APP_URL env var (legacy fallback — may be API server, avoid if possible)
 *
 * If you were seeing a 404 after Stripe payment, set FRONTEND_URL to your
 * GitHub Pages origin (https://flowfit.cctamcc.site) in Vercel env vars.
 */
export async function createCheckoutSession(
  userId: string,
  email: string,
  name: string | null | undefined,
  planId: string,
  interval: BillingInterval,
  successUrl?: string,
  cancelUrl?: string,
): Promise<{ url: string; sessionId: string }> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan)       throw new Error('Plan not found');
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

  // Check for an existing paid subscription (affects trial eligibility)
  const existing = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
  });

  // ── FIX 1: build redirect URLs from params, then FRONTEND_URL, then APP_URL ──
  const base = getFrontendUrl();
  const resolvedSuccessUrl = successUrl
    || `${base}/subscription.html?session_id={CHECKOUT_SESSION_ID}&success=1`;
  const resolvedCancelUrl  = cancelUrl
    || `${base}/subscription.html?cancelled=1`;

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer:   stripeCustomerId,
    mode:       'subscription',
    line_items: [{ price: stripePriceId, quantity: 1 }],
    // FIX 1: use resolved URLs so Stripe redirects to the frontend, not the API
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
    allow_promotion_codes:     true,
    billing_address_collection: 'auto',
    customer_update:            { address: 'auto' },
  };

  const session = await stripe.checkout.sessions.create(sessionParams);

  // Create a pending subscription record immediately.
  // Status is updated to ACTIVE/TRIALING by the Stripe webhook on payment.
  const pendingSub = await prisma.subscription.create({
    data: {
      userId,
      planId,
      status:                 'INCOMPLETE',
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

/**
 * FIX 2 — Cancel a subscription.
 *
 * Previously threw if stripeSubscriptionId was null (M-Pesa users and users
 * with INCOMPLETE Stripe checkouts couldn't cancel at all).
 *
 * Now:
 *  - If stripeSubscriptionId is present → cancel via Stripe API (auto-billing stops)
 *  - If stripeSubscriptionId is null    → cancel DB record directly (M-Pesa /
 *    abandoned checkout — no Stripe subscription to cancel)
 */
export async function cancelSubscription(
  userId: string,
  immediately: boolean = false,
  reason?: string,
  ipAddress?: string,
): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  if (!sub) throw new Error('No active subscription found');

  const prevStatus = sub.status;

  if (sub.stripeSubscriptionId) {
    // ── Stripe-managed subscription ──────────────────────────────────────────
    // Calling the Stripe API ensures auto-billing actually stops.
    if (immediately) {
      // Cancel right now — Stripe fires customer.subscription.deleted webhook
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
      // Cancel at period end — Stripe fires customer.subscription.updated webhook
      // with cancel_at_period_end=true; webhook syncs DB.
      // We also update DB immediately so the UI reflects it without waiting.
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
    // ── FIX 2: No Stripe subscription ID — DB-only cancel ────────────────────
    // Covers:
    //   a) M-Pesa subscriptions (no stripeSubscriptionId by design)
    //   b) INCOMPLETE Stripe checkouts that were abandoned
    // There is no active Stripe subscription to cancel via the API,
    // so we just mark the DB record as cancelled.
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

/**
 * FIX 3 — Reactivate a subscription that was scheduled for cancellation.
 *
 * Previously threw if stripeSubscriptionId was null, making reactivation
 * impossible for M-Pesa users who had set cancelAtPeriodEnd=true.
 *
 * Now:
 *  - If stripeSubscriptionId is present → call Stripe to clear cancel_at_period_end
 *  - If stripeSubscriptionId is null    → clear it in DB only
 */
export async function reactivateSubscription(
  userId: string,
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
    // ── Stripe-managed: tell Stripe to resume billing ─────────────────────────
    // Stripe fires customer.subscription.updated with cancel_at_period_end=false;
    // webhook syncs DB. We also update immediately for instant UI feedback.
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  }
  // ── FIX 3: DB update runs for both Stripe and non-Stripe subs ────────────
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

/**
 * Immediate upgrade — swap Stripe subscription to new price right now.
 * Stripe prorates the charge automatically.
 */
export async function upgradeSubscription(
  userId: string,
  newPlanId: string,
  newInterval: BillingInterval,
  ipAddress?: string,
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
    items:               [{ id: itemId, price: newPriceId }],
    proration_behavior:  'create_prorations',
    metadata:            { userId, planId: newPlanId },
  });

  const prevPlanSlug = sub.plan.slug;
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      planId:             newPlanId,
      interval:           newInterval,
      cancelAtPeriodEnd:  false,
      scheduledPlanId:    null,
      scheduledInterval:  null,
    },
  });

  await logEvent(
    sub.id, 'UPGRADED', sub.status, sub.status,
    { fromPlan: prevPlanSlug, toPlan: newPlan.slug, interval: newInterval },
    ipAddress,
  );

  return (await getCurrentSubscription(userId))!;
}

/**
 * Schedule a downgrade for next billing cycle.
 * User keeps current plan until period end, then switches.
 */
export async function scheduleDowngrade(
  userId: string,
  newPlanId: string,
  newInterval: BillingInterval,
  ipAddress?: string,
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

/**
 * FIX 4 — Return a Stripe Billing Portal URL.
 *
 * Was: return_url used APP_URL (API server) → portal returned to API server.
 * Now: return_url uses FRONTEND_URL first, APP_URL as fallback.
 */
export async function getBillingPortalUrl(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) {
    throw new Error('No billing account found');
  }

  // FIX 4: use FRONTEND_URL so the "Return to FlowFit" link in the portal
  // goes to the frontend app, not the API server.
  const frontendBase = getFrontendUrl();
  const returnUrl    = `${frontendBase}/subscription.html`;

  const session = await stripe.billingPortal.sessions.create({
    customer:   user.stripeCustomerId,
    return_url: returnUrl,
  });

  return session.url;
}

export { prisma };
