/**
 * FLOWFIT — Stripe Subscription Operations
 * Extracted from subscription.service to keep files focused.
 * These functions are re-exported through subscription.service.ts.
 */

import { PrismaClient, BillingInterval, SubscriptionEvent, SubscriptionStatus } from '@prisma/client';
import type { CurrentSubscription } from '../types/subscription.types.js';
import { stripe } from './stripe.service.js';
import { getCurrentSubscription } from './subscription.service.js';
import Stripe from 'stripe';
import prisma from '../config/db.js';

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

export async function cancelSubscription(
  userId: string,
  immediately: boolean = false,
  reason?: string,
  ipAddress?: string,
): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  if (!sub) throw new Error('No active subscription found');

  const prevStatus = sub.status;

  if (sub.provider === 'STRIPE') {
    if (!sub.stripeSubscriptionId) throw new Error('No Stripe subscription ID on record');

    if (immediately) {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelAtPeriodEnd: false, cancellationReason: reason },
      });
      await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', { reason, immediately: true }, ipAddress);
    } else {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true, cancellationReason: reason },
      });
      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus, { reason, atPeriodEnd: true }, ipAddress);
    }
  } else {
    // M-Pesa: just update DB — no Stripe call needed
    const now = new Date();
    if (immediately) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELLED', cancelledAt: now, autoRenew: false, cancellationReason: reason },
      });
      await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED', { reason, immediately: true }, ipAddress);
    } else {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true, autoRenew: false, cancellationReason: reason },
      });
      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus, { reason, atPeriodEnd: true }, ipAddress);
    }
  }

  return (await getCurrentSubscription(userId))!;
}

export async function reactivateSubscription(userId: string, ipAddress?: string): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where: { userId, cancelAtPeriodEnd: true, status: { in: ['ACTIVE', 'TRIALING'] } },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) throw new Error('No subscription scheduled for cancellation');

  if (sub.provider === 'STRIPE') {
    if (!sub.stripeSubscriptionId) throw new Error('No Stripe subscription ID on record');
    await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: false, autoRenew: true, cancellationReason: null },
  });

  await logEvent(sub.id, 'REACTIVATED', sub.status, sub.status, {}, ipAddress);
  return (await getCurrentSubscription(userId))!;
}

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

  if (sub.provider === 'STRIPE') {
    if (!sub.stripeSubscriptionId) throw new Error('No Stripe subscription ID');

    const newPriceId = newInterval === 'YEARLY' ? newPlan.stripePriceIdYearly : newPlan.stripePriceIdMonthly;
    if (!newPriceId) throw new Error(`Stripe price not configured for ${newPlan.slug}/${newInterval}`);

    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const itemId    = stripeSub.items.data[0]?.id;
    if (!itemId) throw new Error('No subscription items on Stripe subscription');

    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: 'create_prorations',
      metadata: { userId, planId: newPlanId },
    });
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { planId: newPlanId, interval: newInterval, cancelAtPeriodEnd: false, scheduledPlanId: null, scheduledInterval: null },
  });

  await logEvent(sub.id, 'UPGRADED', sub.status, sub.status,
    { fromPlan: sub.plan.slug, toPlan: newPlan.slug, interval: newInterval }, ipAddress);

  return (await getCurrentSubscription(userId))!;
}

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

  if (sub.provider === 'STRIPE') {
    if (!sub.stripeSubscriptionId) throw new Error('No Stripe subscription ID');

    const newPriceId = newInterval === 'YEARLY' ? newPlan.stripePriceIdYearly : newPlan.stripePriceIdMonthly;
    if (!newPriceId) throw new Error(`Stripe price not configured for ${newPlan.slug}/${newInterval}`);

    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const itemId    = stripeSub.items.data[0]?.id;

    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: 'none',
      billing_cycle_anchor: 'unchanged',
      metadata: { scheduledPlanId: newPlanId },
    });
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { scheduledPlanId: newPlanId, scheduledInterval: newInterval },
  });

  await logEvent(sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status,
    { fromPlan: sub.plan.slug, toPlan: newPlan.slug, interval: newInterval }, ipAddress);

  return (await getCurrentSubscription(userId))!;
}

export async function getBillingPortalUrl(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
  if (!user?.stripeCustomerId) throw new Error('No billing account found');

  const session = await stripe.billingPortal.sessions.create({
    customer:   user.stripeCustomerId,
    // FIX: use FRONTEND_URL so portal returns to the frontend, not the API server
    return_url: `${process.env.FRONTEND_URL || process.env.APP_URL || ''}/subscription.html`,
  });

  return session.url;
}
