/**
 * FLOWFIT — Paystack Subscription Operations
 * Replaces stripe.subscription.service.ts 1-for-1.
 * Business logic is identical; only the payment-provider calls change.
 *
 * Paystack differences from Stripe:
 *   • Subscriptions are identified by subscription_code (string), not a numeric ID.
 *   • enable/disable calls require both the subscription_code AND the email_token —
 *     both must be stored in the DB when the subscription is created via webhook.
 *   • There is no native proration / mid-cycle upgrade. upgradeSubscription disables
 *     the current subscription and returns a new checkout URL for the target plan.
 *     The new INCOMPLETE row is created here; the webhook completes it on charge.success.
 *   • scheduleDowngrade stores the intent in DB (scheduledPlanId / scheduledInterval).
 *     On the next charge.success webhook the downgrade is applied and a new subscription
 *     is created via Paystack for the lower plan.
 *   • Customer portal: Paystack provides a per-subscription management page at
 *     https://paystack.com/manage/subscriptions/<email_token>
 */

import {
  PrismaClient,
  BillingInterval,
  SubscriptionEvent,
  SubscriptionStatus,
} from '@prisma/client';
import type { CurrentSubscription } from '../types/subscription.types.js';
import {
  fetchPaystackSubscription,
  disablePaystackSubscription,
  enablePaystackSubscription,
  paystackRequest,
} from './paystack.service.js';
import { getCurrentSubscription } from './subscription.service.js';
import prisma from '../config/db.js';

// ─── Shared event logger ──────────────────────────────────────────────────────
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

// ─── Cancel ───────────────────────────────────────────────────────────────────
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

  if (sub.provider === 'PAYSTACK') {
    if (!sub.paystackSubscriptionCode) throw new Error('No Paystack subscription code on record');
    if (!sub.paystackEmailToken)       throw new Error('No Paystack email token on record');

    // Paystack only has one cancel mechanism: disable.
    // For "at period end" we disable AND note cancelAtPeriodEnd in DB.
    await disablePaystackSubscription(sub.paystackSubscriptionCode, sub.paystackEmailToken);

    const now = new Date();
    if (immediately) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status:             'CANCELLED',
          cancelledAt:        now,
          cancelAtPeriodEnd:  false,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED',
        { reason, immediately: true }, ipAddress);
    } else {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd:  true,
          autoRenew:          false,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus,
        { reason, atPeriodEnd: true }, ipAddress);
    }
  } else {
    // M-Pesa: DB-only (unchanged from original)
    const now = new Date();
    if (immediately) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status:             'CANCELLED',
          cancelledAt:        now,
          autoRenew:          false,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCELLED', prevStatus, 'CANCELLED',
        { reason, immediately: true }, ipAddress);
    } else {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd:  true,
          autoRenew:          false,
          cancellationReason: reason,
        },
      });
      await logEvent(sub.id, 'CANCEL_SCHEDULED', prevStatus, prevStatus,
        { reason, atPeriodEnd: true }, ipAddress);
    }
  }

  return (await getCurrentSubscription(userId))!;
}

// ─── Reactivate ───────────────────────────────────────────────────────────────
export async function reactivateSubscription(
  userId:     string,
  ipAddress?: string,
): Promise<CurrentSubscription> {
  const sub = await prisma.subscription.findFirst({
    where:   { userId, cancelAtPeriodEnd: true, status: { in: ['ACTIVE', 'TRIALING'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (!sub) throw new Error('No subscription scheduled for cancellation');

  if (sub.provider === 'PAYSTACK') {
    if (!sub.paystackSubscriptionCode) throw new Error('No Paystack subscription code on record');
    if (!sub.paystackEmailToken)       throw new Error('No Paystack email token on record');
    await enablePaystackSubscription(sub.paystackSubscriptionCode, sub.paystackEmailToken);
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      cancelAtPeriodEnd:  false,
      autoRenew:          true,
      cancellationReason: null,
    },
  });

  await logEvent(sub.id, 'REACTIVATED', sub.status, sub.status, {}, ipAddress);
  return (await getCurrentSubscription(userId))!;
}

// ─── Upgrade ──────────────────────────────────────────────────────────────────
/**
 * Paystack has no native proration / in-place plan change.
 * Strategy:
 *   1. Disable the current subscription immediately.
 *   2. Create an INCOMPLETE subscription row for the new plan.
 *   3. Return a Paystack initialised-transaction URL so the frontend can redirect
 *      the user to complete payment for the new plan.
 * The charge.success webhook will pick up the INCOMPLETE row and activate it.
 */
export async function upgradeSubscription(
  userId:      string,
  newPlanId:   string,
  newInterval: BillingInterval,
  ipAddress?:  string,
): Promise<{ checkoutUrl: string; subscription: CurrentSubscription }> {
  const [sub, newPlan, user] = await Promise.all([
    prisma.subscription.findFirst({
      where:   { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    prisma.plan.findUnique({ where: { id: newPlanId } }),
    prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true, name: true, paystackCustomerCode: true },
    }),
  ]);

  if (!sub)     throw new Error('No active subscription to upgrade');
  if (!newPlan) throw new Error('Target plan not found');
  if (!user)    throw new Error('User not found');

  // Resolve Paystack plan code and amount for the chosen interval
  const paystackPlanCode = newInterval === 'YEARLY'
    ? newPlan.paystackPlanCodeYearly
    : newPlan.paystackPlanCodeMonthly;
  // Paystack amounts must be in the currency's smallest unit (cents for KES).
  // yearlyPriceCents / monthlyPriceCents are already in cents — do NOT use
  // mpesaYearlyKes / mpesaMonthlyKes (those are M-Pesa KES whole shillings).
  const amountKobo = newInterval === 'YEARLY'
    ? newPlan.yearlyPriceCents
    : newPlan.monthlyPriceCents;

  if (!paystackPlanCode) {
    throw new Error(`Paystack plan code not configured for ${newPlan.slug}/${newInterval}`);
  }

  const prevStatus = sub.status;

  // 1. Disable the current Paystack subscription
  if (sub.provider === 'PAYSTACK') {
    if (!sub.paystackSubscriptionCode) throw new Error('No Paystack subscription code');
    if (!sub.paystackEmailToken)       throw new Error('No Paystack email token');
    await disablePaystackSubscription(sub.paystackSubscriptionCode, sub.paystackEmailToken);
  }

  await logEvent(sub.id, 'UPGRADED', prevStatus, prevStatus,
    {
      fromPlan: (sub as any).plan?.slug,
      toPlan:   newPlan.slug,
      interval: newInterval,
      note:     'cancelled_for_upgrade',
    },
    ipAddress,
  );

  // 2. Create an INCOMPLETE subscription row for the new plan
  const newSub = await prisma.subscription.create({
    data: {
      userId,
      planId:   newPlanId,
      status:   'INCOMPLETE',
      provider: 'PAYSTACK',
      interval: newInterval,
    },
  });

  // 3. Initialise a Paystack transaction for the new plan
  const callbackUrl = `${process.env.FRONTEND_URL ?? ''}/subscription.html`;
  const txInit      = await paystackRequest<{ authorization_url: string; reference: string }>(
    'POST',
    '/transaction/initialize',
    {
      email:    user.email,
      amount:   amountKobo,          // in Kobo (KES smallest unit)
      plan:     paystackPlanCode,
      callback_url: callbackUrl,
      metadata: {
        userId,
        planId:         newPlanId,
        interval:       newInterval,
        subscriptionId: newSub.id,   // lets webhook find the INCOMPLETE row
        cancel_action:  'upgrade',
      },
    },
  );

  return {
    checkoutUrl:  txInit.authorization_url,
    subscription: (await getCurrentSubscription(userId))!,
  };
}

// ─── Schedule downgrade ───────────────────────────────────────────────────────
/**
 * Records the intended downgrade in DB. Paystack has no built-in schedule mechanic,
 * so the charge.success webhook handler checks scheduledPlanId and applies the
 * downgrade at the next renewal by disabling the current sub and creating a new one.
 */
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

  await logEvent(sub.id, 'DOWNGRADE_SCHEDULED', sub.status, sub.status,
    {
      fromPlan: (sub as any).plan?.slug,
      toPlan:   newPlan.slug,
      interval: newInterval,
    },
    ipAddress,
  );

  return (await getCurrentSubscription(userId))!;
}

// ─── Billing portal ───────────────────────────────────────────────────────────
/**
 * Paystack provides a per-subscription management page at:
 *   https://paystack.com/manage/subscriptions/<email_token>
 * The email_token is returned when the subscription is created and must be stored.
 */
export async function getBillingPortalUrl(userId: string): Promise<string> {
  const sub = await prisma.subscription.findFirst({
    where:   { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] }, provider: 'PAYSTACK' },
    orderBy: { createdAt: 'desc' },
    select:  { paystackEmailToken: true },
  });

  if (!sub?.paystackEmailToken) throw new Error('No Paystack subscription management token found');

  return `https://paystack.com/manage/subscriptions/${sub.paystackEmailToken}`;
}
