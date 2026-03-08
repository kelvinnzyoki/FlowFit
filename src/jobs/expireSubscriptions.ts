/**
 * FLOWFIT — Subscription Expiry Job
 *
 * Run this on a cron schedule (e.g. every hour).
 * It catches any subscriptions that Stripe has cancelled but our webhook
 * missed (network failures, etc.) and expires trials that weren't converted.
 *
 * Recommended cron: 0 * * * *  (every hour)
 */

import { PrismaClient } from '@prisma/client';
import { stripe } from '../services/stripe.service.js';

const prisma = new PrismaClient();

export async function expireStaleSubscriptions(): Promise<void> {
  const now = new Date();

  // 1. Expire trials that have passed trialEndsAt with no payment
  const expiredTrials = await prisma.subscription.findMany({
    where: {
      status: 'TRIALING',
      trialEndsAt: { lt: now },
    },
  });

  for (const sub of expiredTrials) {
    if (sub.stripeSubscriptionId) {
      // Trust Stripe as source of truth — check current status
      try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        if (stripeSub.status === 'trialing') continue; // Stripe says still active
      } catch { /* subscription deleted on Stripe */ }
    }

    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED', expiredAt: now },
      }),
      prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event: 'TRIAL_EXPIRED',
          previousStatus: 'TRIALING',
          newStatus: 'EXPIRED',
          metadata: { reason: 'job_expiry', expiredAt: now.toISOString() },
        },
      }),
    ]);

    console.log(`[expireJob] Expired trial subscription ${sub.id}`);
  }

  // 2. Mark INCOMPLETE subscriptions older than 24h as INCOMPLETE_EXPIRED
  const staleIncomplete = await prisma.subscription.findMany({
    where: {
      status: 'INCOMPLETE',
      createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
  });

  for (const sub of staleIncomplete) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'INCOMPLETE_EXPIRED' },
    });
    console.log(`[expireJob] Expired stale incomplete subscription ${sub.id}`);
  }

  // 3. Apply scheduled downgrades that passed currentPeriodEnd
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
          metadata: { reason: 'job_downgrade', toPlanId: sub.scheduledPlanId },
        },
      }),
    ]);
    console.log(`[expireJob] Applied downgrade for subscription ${sub.id}`);
  }
}

// If run directly
if (require.main === module) {
  expireStaleSubscriptions()
    .then(() => console.log('Done.'))
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
