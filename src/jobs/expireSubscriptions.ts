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

import prisma from '../config/db.js';

// ── Paystack REST helper ───────────────────────────────────────────────────────
// Fetches a subscription by its code. Returns the status string, or null if
// the request fails (e.g. subscription was deleted on Paystack).
// Paystack subscription statuses: active | non-renewing | attention | completed | cancelled

// FIX-3: Warn loudly on missing secret key without crashing the serverless cold start.
// fetchPaystackSubscriptionStatus handles an empty key gracefully by returning null
// on non-ok Paystack responses.
if (!process.env.PAYSTACK_SECRET_KEY) {
  console.error('[expireSubscriptions] PAYSTACK_SECRET_KEY env var is not set; Paystack status checks will return null.');
}
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY ?? '';

async function fetchPaystackSubscriptionStatus(
  subscriptionCode: string,
): Promise<string | null> {
  try {
    // FIX-5: Hard timeout so a slow Paystack response cannot hang the entire expiry
    // job indefinitely. The job processes every TRIALING sub sequentially; one
    // stalled fetch would block all subsequent rows from being evaluated.
    const res = await fetch(
      `https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`,
      {
        headers: {
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type':  'application/json',
        },
        signal: AbortSignal.timeout(10_000),
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
      // 650 ms ≈ 92 req/min — safely under Paystack's published 100 req/min rate limit.
      await new Promise(resolve => setTimeout(resolve, 650)); // Paystack: ~100 req/min
      // AUDIT-FIX-11: Paystack status checks are throttled under the published rate limit.
      const psStatus = await fetchPaystackSubscriptionStatus(sub.paystackSubscriptionCode);
      // If Paystack cannot be reached or returns an unknown response, do not expire
      // the user during an external provider/API outage. Retry on the next cron run.
      if (psStatus === null) {
        console.warn(`[expireJob] Skipping trial subscription ${sub.id} — Paystack status check failed; will retry later.`);
        continue;
      }
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
    // FIX-2: Skip Paystack rows that have been paid but whose subscription.create
    // webhook has not fired yet. Paystack retry backoff can exceed 24 hours — expiring
    // a paid row here revokes access for a paying customer before the codes arrive.
    // A paid row has paystackReference set AND currentPeriodEnd in the future.
    if (
      sub.provider === 'PAYSTACK' &&
      sub.paystackReference &&
      sub.currentPeriodEnd &&
      sub.currentPeriodEnd > now
    ) {
      console.log(
        `[expireJob] Skipping paid PAYSTACK INCOMPLETE sub ${sub.id} — ` +
        `period end ${sub.currentPeriodEnd.toISOString()} is in the future. ` +
        `Awaiting subscription.create webhook.`,
      );
      continue;
    }

    await prisma.subscription.update({
      where: { id: sub.id },
      data:  { status: 'INCOMPLETE_EXPIRED' },
    });
    console.log(`[expireJob] Expired stale incomplete subscription ${sub.id}`);
  }

  // ── 3. Scheduled downgrades are intentionally not applied here ─────────────
  // Lazy processing in getCurrentSubscription/applyPendingDowngradeIfDue creates
  // the replacement Paystack subscription before switching the plan. A DB-only
  // planId swap here would grant the lower plan without live billing.
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
