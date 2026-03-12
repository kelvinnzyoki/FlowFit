import { PrismaClient, SubscriptionStatus, BillingInterval, SubscriptionEvent } from '@prisma/client';
import type { PublicPlan, CurrentSubscription } from '../types/subscription.types.js';
import { stripe, getOrCreateStripeCustomer } from './stripe.service.js';
import Stripe from 'stripe';

const prisma = new PrismaClient();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysUntil(date: Date | null | undefined): number | null {
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
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

// ─── Public API ───────────────────────────────────────────────────────────────

/** All active, ordered plans for the pricing page */
export async function getPlans(): Promise<PublicPlan[]> {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  return plans.map(toPublicPlan);
}

/** The user's current (most recent) subscription */
export async function getCurrentSubscription(userId: string): Promise<CurrentSubscription | null> {
  // Exclude INCOMPLETE / INCOMPLETE_EXPIRED — these are abandoned checkout sessions.
  // Without this filter, an abandoned Stripe checkout shows as the current plan
  // and blocks the cancel endpoint (which only accepts ACTIVE/TRIALING/PAST_DUE).
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { notIn: ['INCOMPLETE', 'INCOMPLETE_EXPIRED'] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      plan: true,
    },
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
  };
}

/**
 * Create a Stripe Checkout Session.
 * Returns the session URL — frontend redirects to it.
 * Subscription only activates after webhook confirms payment.
 */
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

  // Check for existing active subscription to determine if this is an upgrade
  const existing = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
  });

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: stripePriceId, quantity: 1 }],
    // Use API redirect routes instead of pointing directly at .html files.
    // Express doesn't serve static HTML by default — hitting /subscription.html
    // through the API server returns 404. The /redirect routes below do a 302
    // to wherever FRONTEND_URL points (can be same domain or separate).
    success_url: `${process.env.APP_URL}/api/v1/subscriptions/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${process.env.APP_URL}/api/v1/subscriptions/checkout-cancel`,
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
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    customer_update: { address: 'auto' },
  };

  const session = await stripe.checkout.sessions.create(sessionParams);

  // Create a pending subscription record immediately
  // Status will be updated by webhook when payment is confirmed
  const pendingSub = await prisma.subscription.create({
    data: {
      userId,
      planId,
      status: 'INCOMPLETE',
      interval,
      stripeCheckoutSessionId: session.id,
      trialStartedAt: plan.trialDays > 0 && !existing ? new Date() : null,
      trialEndsAt:
        plan.trialDays > 0 && !existing
          ? new Date(Date.now() + plan.trialDays * 86_400_000)
          : null,
    },
  });

  await logEvent(pendingSub.id, 'CREATED', null, 'INCOMPLETE', {
    planSlug: plan.slug,
    interval,
    sessionId: session.id,
  });

  return { url: session.url!, sessionId: session.id };
}

/**
 * Cancel a subscription.
 * By default: cancel at period end (user keeps access until then).
 * immediately=true: cancel right now (use for refund flows).
 */
export async function cancelSubscription(
  userId: string,
  immediately: boolean = false,
  reason?: string,
  ipAddress?: string,
): Promise<CurrentSubscription> {
  // Also match INCOMPLETE — user may want to abandon an in-progress checkout
  const sub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'INCOMPLETE'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  if (!sub) throw new Error('No active subscription found');

  // INCOMPLETE = abandoned checkout — no Stripe subscription exists yet, just expire it in DB
  if (sub.status === 'INCOMPLETE') {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'INCOMPLETE_EXPIRED' },
    });
    await logEvent(sub.id, 'CANCELLED', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', { reason: 'user_abandoned_checkout' }, ipAddress);
    return (await getCurrentSubscription(userId)) as CurrentSubscription ?? { plan: { slug: 'free' } } as any;
  }

  const prevStatus = sub.status;
  const isMpesa = !sub.stripeSubscriptionId;

  if (immediately) {
    // M-Pesa: no Stripe to cancel — update DB only
    if (!isMpesa) await stripe.subscriptions.cancel(sub.stripeSubscriptionId!);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelAtPeriodEnd: false,
        cancellationReason: reason,
      },
    });
    await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', { reason, immediately: true, via: isMpesa ? 'mpesa' : 'stripe' }, ipAddress);
  } else {
    // M-Pesa: no Stripe to update — DB flag only; access until currentPeriodEnd
    if (!isMpesa) await stripe.subscriptions.update(sub.stripeSubscriptionId!, { cancel_at_period_end: true });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true, cancellationReason: reason },
    });
    await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus, { reason, atPeriodEnd: true, via: isMpesa ? 'mpesa' : 'stripe' }, ipAddress);
  }

  return (await getCurrentSubscription(userId))!;
}

/**
 * Reactivate a subscription that was scheduled for cancellation.
 * Cannot reactivate an already-cancelled subscription (must start new checkout).
 */
export async function reactivateSubscription(userId: string, ipAddress?: string): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where: { userId, cancelAtPeriodEnd: true, status: { in: ['ACTIVE', 'TRIALING'] } },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) throw new Error('No subscription scheduled for cancellation');

  // M-Pesa subscriptions have no Stripe ID — update DB only
  if (!sub.stripeSubscriptionId) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: false, cancellationReason: null },
    });
    await logEvent(sub.id, 'REACTIVATED', sub.status, sub.status, { via: 'mpesa' }, ipAddress);
    return (await getCurrentSubscription(userId))!;
  }

  await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: false, cancellationReason: null },
  });

  await logEvent(sub.id, 'REACTIVATED', sub.status, sub.status, {}, ipAddress);
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
      where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    prisma.plan.findUnique({ where: { id: newPlanId } }),
  ]);

  if (!sub) throw new Error('No active subscription to upgrade');
  if (!newPlan) throw new Error('Target plan not found');

  // M-Pesa subscription — Stripe cannot swap the price. The caller should
  // direct the user to pay for the new plan via M-Pesa or Stripe checkout.
  if (!sub.stripeSubscriptionId) {
    throw new Error('MPESA_UPGRADE_REQUIRED');
  }

  const newPriceId = newInterval === 'YEARLY' ? newPlan.stripePriceIdYearly : newPlan.stripePriceIdMonthly;
  if (!newPriceId) throw new Error(`Stripe price not configured for ${newPlan.slug}/${newInterval}`);

  // Fetch current Stripe subscription items
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error('No subscription items on Stripe subscription');

  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'create_prorations',
    metadata: { userId, planId: newPlanId },
  });

  const prevPlanSlug = sub.plan.slug;
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      planId: newPlanId,
      interval: newInterval,
      cancelAtPeriodEnd: false,
      scheduledPlanId: null,
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
      where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    prisma.plan.findUnique({ where: { id: newPlanId } }),
  ]);

  if (!sub) throw new Error('No active subscription');
  if (!newPlan) throw new Error('Target plan not found');

  const isFreeTarget = newPlan.monthlyPriceCents === 0;
  const isMpesaSub   = !sub.stripeSubscriptionId;

  // M-Pesa subscriptions have no Stripe — handle entirely in DB
  if (isMpesaSub) {
    if (isFreeTarget) {
      // Downgrade to free: set cancelAtPeriodEnd so access continues until period ends
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true, scheduledPlanId: newPlanId, scheduledInterval: newInterval },
      });
      await logEvent(sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status,
        { fromPlan: sub.plan.slug, toPlan: 'free', toFree: true, via: 'mpesa' }, ipAddress);
      return (await getCurrentSubscription(userId))!;
    }
    // Downgrade to a lower paid plan: require new M-Pesa payment for that plan
    throw new Error('MPESA_DOWNGRADE_REQUIRED');
  }

  // TypeScript narrowing: isMpesaSub is false here, so stripeSubscriptionId is non-null
  const stripeSubId = sub.stripeSubscriptionId as string;

  if (isFreeTarget) {
    // Downgrading to free = cancel at period end. Free has no Stripe price,
    // so we simply stop Stripe from renewing. User keeps access until periodEnd.
    await stripe.subscriptions.update(stripeSubId, {
      cancel_at_period_end: true,
    });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        cancelAtPeriodEnd:  true,
        scheduledPlanId:    newPlanId,
        scheduledInterval:  newInterval,
      },
    });
    await logEvent(
      sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status,
      { fromPlan: sub.plan.slug, toPlan: 'free', toFree: true },
      ipAddress,
    );
    return (await getCurrentSubscription(userId))!;
  }

  // Paid → lower paid plan: swap Stripe price at next billing cycle
  const newPriceId = newInterval === 'YEARLY' ? newPlan.stripePriceIdYearly : newPlan.stripePriceIdMonthly;
  if (!newPriceId) throw new Error(`Stripe price not configured for ${newPlan.slug}/${newInterval}`);

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
  const itemId = stripeSub.items.data[0]?.id;

  await stripe.subscriptions.update(stripeSubId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'none',
    billing_cycle_anchor: 'unchanged',
    metadata: { scheduledPlanId: newPlanId },
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
 * Return a Stripe Billing Portal URL so users can manage
 * payment methods, invoices, and subscription themselves.
 */
export async function getBillingPortalUrl(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
  if (!user?.stripeCustomerId) throw new Error('No billing account found');

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${process.env.APP_URL}/subscription.html`,
  });

  return session.url;
}

export { prisma };
