/**
 * FLOWFIT — Subscription Expiry Job
 *
 * FIXES APPLIED:
 *   FIX-M1   ESM-compatible direct-run guard — `require.main === module` throws
 *            ReferenceError in ESM. Replaced with import.meta.url comparison.
 *
 *   PAYSTACK  Replaced all Stripe SDK calls with direct Paystack REST API calls.
 *            Paystack subscription statuses: active | non-renewing | attention |
 *            completed | cancelled. There is no 'trialing' status — a subscription
 *            in a free-trial window is still reported as 'active' by Paystack.
 *            Guard: if Paystack confirms the subscription is still 'active',
 *            skip expiry (same intent as the old Stripe 'trialing' guard).
 *
 *   FIELD     stripeSubscriptionId → paystackSubscriptionCode
 *            (Paystack identifies subscriptions by a string code, e.g. SUB_xxxx)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Paystack REST helper ───────────────────────────────────────────────────────
// Fetches a subscription by its code. Returns the status string, or null if
// the request fails (e.g. subscription was deleted on Paystack).
// Paystack subscription statuses: active | non-renewing | attention | completed | cancelled

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY ?? '';

async function fetchPaystackSubscriptionStatus(
  subscriptionCode: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`,
      {
        headers: {
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type':  'application/json',
        },
      },
    );
    if (!res.ok) return null;
    const body = await res.json() as { status: boolean; data?: { status: string } };
    return body.data?.status ?? null;
  } catch {
    return null; // network error — treat as deleted/unknown
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function expireStaleSubscriptions(): Promise<void> {
  const now = new Date();

  // ── 1. Expire trials that have passed trialEndsAt with no payment ─────────
  const expiredTrials = await prisma.subscription.findMany({
    where: {
      status:      'TRIALING',
      trialEndsAt: { lt: now },
    },
  });

  for (const sub of expiredTrials) {
    if (sub.paystackSubscriptionCode) {
      const psStatus = await fetchPaystackSubscriptionStatus(sub.paystackSubscriptionCode);
      // Paystack confirms subscription is live — do not expire it from our side.
      // ('active' covers both paying and still-in-trial-window subscriptions on Paystack)
      if (psStatus === 'active') continue;
    }

    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data:  { status: 'EXPIRED', expiredAt: now },
      }),
      prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event:          'TRIAL_EXPIRED',
          previousStatus: 'TRIALING',
          newStatus:      'EXPIRED',
          metadata: { reason: 'job_expiry', expiredAt: now.toISOString() },
        },
      }),
    ]);

    console.log(`[expireJob] Expired trial subscription ${sub.id}`);
  }

  // ── 2. Mark INCOMPLETE subscriptions older than 24 h as INCOMPLETE_EXPIRED ─
  const staleIncomplete = await prisma.subscription.findMany({
    where: {
      status:    'INCOMPLETE',
      createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
  });

  for (const sub of staleIncomplete) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data:  { status: 'INCOMPLETE_EXPIRED' },
    });
    console.log(`[expireJob] Expired stale incomplete subscription ${sub.id}`);
  }

  // ── 3. Apply scheduled downgrades that passed currentPeriodEnd ────────────
  const dueDowngrades = await prisma.subscription.findMany({
    where: {
      scheduledPlanId:  { not: null },
      currentPeriodEnd: { lt: now },
      status:           { in: ['ACTIVE', 'TRIALING'] },
    },
  });

  for (const sub of dueDowngrades) {
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: {
          planId:            sub.scheduledPlanId!,
          interval:          sub.scheduledInterval!,
          scheduledPlanId:   null,
          scheduledInterval: null,
        },
      }),
      prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event:          'DOWNGRADE_APPLIED',
          previousStatus: sub.status,
          newStatus:      sub.status,
          metadata: { reason: 'job_downgrade', toPlanId: sub.scheduledPlanId },
        },
      }),
    ]);
    console.log(`[expireJob] Applied downgrade for subscription ${sub.id}`);
  }
}

// ── FIX-M1: ESM-compatible direct-run guard ───────────────────────────────────
// `require.main === module` is undefined in ES modules — throws ReferenceError.
// Use import.meta.url comparison instead.
// To run directly: node --loader ts-node/esm src/jobs/expireSubscriptions.ts
const isMain = process.argv[1]
  ? new URL(import.meta.url).pathname.endsWith(
      process.argv[1].replace(/\\/g, '/').split('/').pop()!,
    )
  : false;

if (isMain) {
  expireStaleSubscriptions()
    .then(() => console.log('Done.'))
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
