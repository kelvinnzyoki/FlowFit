/**
 * FLOWFIT — One-time database seed endpoint
 *
 * Exposes POST /api/v1/admin/seed-plans
 * Protected by SEED_SECRET env var — no secret, no access.
 *
 * HOW TO USE (from your phone):
 *   1. Add SEED_SECRET=any-long-random-string to your Vercel env vars
 *   2. Deploy (push this file + register the route in your app entry point)
 *   3. Open your browser or any HTTP client and call:
 *        POST https://fit.cctamcc.site/api/v1/admin/seed-plans
 *        Header:  x-seed-secret: <your SEED_SECRET value>
 *      OR use the GET version which you can hit directly from a browser address bar:
 *        GET https://fit.cctamcc.site/api/v1/admin/seed-plans?secret=<your SEED_SECRET value>
 *   4. You'll get back JSON listing every plan that was upserted with its DB id
 *   5. Copy those IDs — you need them to link Stripe price IDs
 *   6. After seeding, delete SEED_SECRET from Vercel env vars to disable the route
 *
 * Safe to call multiple times — uses upsert on slug so nothing is duplicated.
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';

const router = Router();

// ─── Plan definitions (copied from plans.config.ts) ───────────────────────────
// Kept inline so this file is completely self-contained and has zero import issues.
const PLAN_SEEDS = [
  {
    slug: 'free',
    name: 'Free',
    description: 'Get started with the basics.',
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    trialDays: 0,
    maxWorkoutsPerMonth: 10,
    maxPrograms: 1,
    hasAdvancedAnalytics: false,
    hasPersonalCoaching: false,
    hasNutritionTracking: false,
    hasOfflineAccess: false,
    features: [
      'Up to 10 workouts per month',
      '1 active program',
      'Basic progress tracking',
      'Exercise library access',
    ],
    displayOrder: 0,
    isActive: true,
    isPopular: false,
  },
  {
    slug: 'pro',
    name: 'Pro',
    description: 'Everything you need to crush your goals.',
    monthlyPriceCents: 1499,
    yearlyPriceCents: 11988,
    trialDays: 14,
    maxWorkoutsPerMonth: null,
    maxPrograms: null,
    hasAdvancedAnalytics: true,
    hasPersonalCoaching: false,
    hasNutritionTracking: true,
    hasOfflineAccess: false,
    features: [
      'Unlimited workouts',
      'Unlimited programs',
      'Advanced analytics & charts',
      'Nutrition tracking',
      'Priority support',
      '14-day free trial',
    ],
    displayOrder: 1,
    isActive: true,
    isPopular: true,
  },
  {
    slug: 'elite',
    name: 'Elite',
    description: 'The complete performance platform.',
    monthlyPriceCents: 2999,
    yearlyPriceCents: 23988,
    trialDays: 7,
    maxWorkoutsPerMonth: null,
    maxPrograms: null,
    hasAdvancedAnalytics: true,
    hasPersonalCoaching: true,
    hasNutritionTracking: true,
    hasOfflineAccess: true,
    features: [
      'Everything in Pro',
      'Personal AI coaching',
      'Offline access & sync',
      'Custom program builder',
      'Body composition analysis',
      'Dedicated account manager',
      '7-day free trial',
    ],
    displayOrder: 2,
    isActive: true,
    isPopular: false,
  },
];

// ─── Auth helper ──────────────────────────────────────────────────────────────
function isAuthorized(req: Request): boolean {
  const secret = process.env.SEED_SECRET;
  if (!secret) return false; // env var not set → always locked

  // Accept secret via header OR query param (query = easy browser test)
  const headerSecret = req.headers['x-seed-secret'];
  const querySecret  = req.query.secret as string | undefined;
  return headerSecret === secret || querySecret === secret;
}

// ─── POST /admin/seed-plans ───────────────────────────────────────────────────
// Also handles GET so you can call it from a browser address bar for quick testing
async function seedHandler(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized. Provide x-seed-secret header or ?secret= query param.' });
    return;
  }

  const results: Array<{ slug: string; name: string; id: string; action: string }> = [];

  try {
    for (const plan of PLAN_SEEDS) {
      // Check if plan already exists so we can report create vs update
      const existing = await prisma.plan.findUnique({ where: { slug: plan.slug } });

      const upserted = await prisma.plan.upsert({
        where:  { slug: plan.slug },
        create: { ...plan, features: plan.features as any },
        update: { ...plan, features: plan.features as any },
        select: { id: true, slug: true, name: true },
      });

      results.push({
        slug:   upserted.slug,
        name:   upserted.name,
        id:     upserted.id,
        action: existing ? 'updated' : 'created',
      });
    }

    res.json({
      success: true,
      message: `${results.length} plans seeded successfully.`,
      plans: results,
      nextSteps: [
        '1. Copy the plan IDs above',
        '2. In Stripe Dashboard: create a product for Pro and Elite',
        '3. Under each product: create a recurring Monthly price and a recurring Yearly price',
        '4. Run SQL or use /admin/set-stripe-prices to store those price IDs on each plan',
        '5. Remove SEED_SECRET from your Vercel env vars to disable this endpoint',
      ],
    });
  } catch (err: any) {
    console.error('[seed-plans]', err);
    res.status(500).json({ error: err.message ?? 'Seed failed', detail: err.toString() });
  }
}

router.get('/seed-plans',  seedHandler);
router.post('/seed-plans', seedHandler);


// ─── GET|POST /admin/set-stripe-prices ───────────────────────────────────────
// Registered as both GET and POST so you can call it directly from a browser.
//
// Browser URL (GET) — paste this directly into your phone browser:
//   https://fit.cctamcc.site/api/v1/admin/set-stripe-prices
//     ?secret=YOUR_SECRET&slug=pro&monthly=price_xxx&yearly=price_yyy
//
// POST body (for REST clients) — same fields work in req.body too.
//
async function setStripePricesHandler(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  // Read from query params (browser GET) OR request body (POST) — whichever is provided
  const q = req.query;
  const b = (req.body ?? {}) as Record<string, string>;

  const slug                 = (q.slug    || b.slug)                 as string | undefined;
  const stripePriceIdMonthly = (q.monthly || b.stripePriceIdMonthly) as string | undefined;
  const stripePriceIdYearly  = (q.yearly  || b.stripePriceIdYearly)  as string | undefined;

  if (!slug) {
    res.status(400).json({ error: 'slug is required. Add ?slug=pro to the URL.' });
    return;
  }
  if (!stripePriceIdMonthly && !stripePriceIdYearly) {
    res.status(400).json({ error: 'Provide at least one price: ?monthly=price_xxx or ?yearly=price_yyy' });
    return;
  }

  try {
    const plan = await prisma.plan.findUnique({ where: { slug } });
    if (!plan) { res.status(404).json({ error: `Plan with slug "${slug}" not found` }); return; }

    const updated = await prisma.plan.update({
      where: { slug },
      data: {
        ...(stripePriceIdMonthly ? { stripePriceIdMonthly } : {}),
        ...(stripePriceIdYearly  ? { stripePriceIdYearly  } : {}),
      },
      select: { id: true, slug: true, name: true, stripePriceIdMonthly: true, stripePriceIdYearly: true },
    });

    res.json({ success: true, plan: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

router.get('/set-stripe-prices',  setStripePricesHandler);
router.post('/set-stripe-prices', setStripePricesHandler);


// ─── GET /admin/plans ─────────────────────────────────────────────────────────
// Quick read — shows all plans + their current Stripe price IDs so you can verify
router.get('/plans', async (req: Request, res: Response): Promise<void> => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }
  const plans = await prisma.plan.findMany({
    orderBy: { displayOrder: 'asc' },
    select: {
      id: true, slug: true, name: true,
      monthlyPriceCents: true, yearlyPriceCents: true,
      stripePriceIdMonthly: true, stripePriceIdYearly: true,
      isActive: true,
    },
  });
  res.json({ plans });
});



// ─── GET /admin/clear-incomplete ──────────────────────────────────────────────
// One-time fix: expires all INCOMPLETE subscriptions for a user.
// Use when a user abandoned a Stripe checkout and is now stuck.
// URL: /api/v1/admin/clear-incomplete?secret=YOUR_SECRET&userId=USER_ID
// Get userId from /api/v1/admin/plans?secret=... or your DB viewer.
// If no userId param, clears ALL stale INCOMPLETE subscriptions older than 1 hour.
router.get('/clear-incomplete', async (req: Request, res: Response): Promise<void> => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const userId = req.query.userId as string | undefined;

  try {
    const where = userId
      ? { userId, status: 'INCOMPLETE' as any }
      : {
          status: 'INCOMPLETE' as any,
          createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) }, // older than 1 hour
        };

    const updated = await prisma.subscription.updateMany({
      where,
      data: { status: 'INCOMPLETE_EXPIRED' },
    });

    res.json({
      success: true,
      cleared: updated.count,
      message: updated.count > 0
        ? `${updated.count} incomplete subscription(s) cleared. User can now subscribe fresh.`
        : 'No incomplete subscriptions found matching that criteria.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ─── GET /admin/reset-subscription ───────────────────────────────────────────
// DEV/TESTING ONLY — wipes all subscription records for a user so they can
// subscribe again from scratch. Also cancels the Stripe subscription if one
// exists, so Stripe stays in sync.
//
// Usage (paste in browser):
//   /api/v1/admin/reset-subscription?secret=YOUR_SECRET&email=you@example.com
//
// After calling this:
//   - All your DB subscriptions are deleted
//   - Your Stripe subscription is cancelled immediately (no invoice)
//   - You can subscribe to any plan again as if you're a new user
//   - Trials are available again (Stripe grants trials per customer, so use
//     a fresh Stripe test customer if you want the trial again — see note below)
//
// NOTE ON TRIALS: Stripe tracks trial usage per customer ID. If you want
// the free trial again in the same test session, also pass ?resetStripe=1
// which deletes your stripeCustomerId from the DB so a new customer is created
// on next checkout, giving you a fresh trial.
router.get('/reset-subscription', async (req: Request, res: Response): Promise<void> => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const email       = req.query.email as string | undefined;
  const resetStripe = req.query.resetStripe === '1';

  if (!email) {
    res.status(400).json({ error: 'email param is required. Add ?email=you@example.com' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, stripeCustomerId: true },
    });

    if (!user) {
      res.status(404).json({ error: `No user found with email: ${email}` });
      return;
    }

    const results: string[] = [];

    // 1. Cancel active Stripe subscription if one exists
    if (user.stripeCustomerId) {
      try {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });

        const subs = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'all',
          limit: 10,
        });

        for (const sub of subs.data) {
          if (['active', 'trialing', 'past_due', 'incomplete'].includes(sub.status)) {
            await stripe.subscriptions.cancel(sub.id);
            results.push(`Cancelled Stripe subscription: ${sub.id}`);
          }
        }

        // If resetStripe=1, remove stripeCustomerId so next checkout creates a fresh customer
        if (resetStripe) {
          await prisma.user.update({
            where: { id: user.id },
            data: { stripeCustomerId: null },
          });
          results.push(`Cleared stripeCustomerId — next checkout creates a fresh Stripe customer (trial available again)`);
        }
      } catch (stripeErr: any) {
        results.push(`Stripe warning: ${stripeErr.message} (DB reset will still proceed)`);
      }
    } else {
      results.push('No Stripe customer ID on file — skipping Stripe cancellation');
    }

    // 2. Delete all subscription records from DB for this user
    const deleted = await prisma.subscription.deleteMany({
      where: { userId: user.id },
    });
    results.push(`Deleted ${deleted.count} subscription record(s) from DB`);

    res.json({
      success: true,
      user: { email: user.email, id: user.id },
      actions: results,
      message: 'Subscription reset. You can now subscribe again from scratch.',
      tip: resetStripe
        ? 'Fresh Stripe customer will be created on next checkout — free trial is available again.'
        : 'To also reset your free trial eligibility, add ?resetStripe=1 to the URL.',
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ─── GET /admin/simulate-mpesa ────────────────────────────────────────────────
// DEV/TESTING ONLY — simulates a successful Safaricom STK callback for a
// pending M-Pesa transaction. Use this when testing with 254708374149 since
// the sandbox number never receives a real STK push.
//
// Usage (paste in browser — no extra tools needed):
//   /api/v1/admin/simulate-mpesa?secret=YOUR_SECRET&checkoutRequestId=ws_CO_xxx
//
// How to get the checkoutRequestId:
//   1. Open M-Pesa modal, enter 254708374149, click SEND REQUEST
//   2. When it shows "WAITING FOR PAYMENT..." open browser DevTools → Network tab
//      and look for the /mpesa/initiate response — copy checkoutRequestId from it
//   OR: use /api/v1/admin/list-pending-mpesa?secret=YOUR_SECRET to list all pending
//
// After calling this endpoint the polling on your subscription page will detect
// COMPLETED status within 5 seconds and activate the subscription automatically.
router.get('/simulate-mpesa', async (req: Request, res: Response): Promise<void> => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const checkoutRequestId = req.query.checkoutRequestId as string | undefined;

  if (!checkoutRequestId) {
    // If no ID given, list all pending transactions so user can pick one
    const pending = await prisma.mpesaTransaction.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { user: { select: { email: true } }, plan: { select: { name: true } } },
    });
    res.json({
      tip: 'Pass ?checkoutRequestId=xxx to simulate payment for that transaction',
      pendingTransactions: pending.map(t => ({
        checkoutRequestId: t.checkoutRequestId,
        user: t.user.email,
        plan: t.plan.name,
        interval: t.interval,
        amountKes: t.amountKes,
        createdAt: t.createdAt,
        simulateUrl: `/api/v1/admin/simulate-mpesa?secret=${req.query.secret}&checkoutRequestId=${t.checkoutRequestId}`,
      })),
    });
    return;
  }

  const txn = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
  });

  if (!txn) {
    res.status(404).json({ error: `No transaction found with checkoutRequestId: ${checkoutRequestId}` });
    return;
  }
  if (txn.status !== 'PENDING') {
    res.status(400).json({ error: `Transaction is already ${txn.status} — can only simulate PENDING transactions` });
    return;
  }

  // Simulate exactly what Safaricom POSTs to /mpesa/callback on success
  const fakeReceipt = `SIM${Date.now().toString().slice(-8)}`;
  const results: string[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Mark M-Pesa transaction completed
      await tx.mpesaTransaction.update({
        where: { checkoutRequestId },
        data: { status: 'COMPLETED', mpesaReceiptNumber: fakeReceipt },
      });
      results.push(`Marked transaction COMPLETED (receipt: ${fakeReceipt})`);

      // 2. Cancel any existing active subscription for this user
      await tx.subscription.updateMany({
        where: { userId: txn.userId, status: { in: ['ACTIVE', 'TRIALING'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      // 3. Calculate period end
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + (txn.interval === 'MONTHLY' ? 1 : 12));

      // 4. Create active subscription
      const sub = await tx.subscription.create({
        data: {
          userId:             txn.userId,
          planId:             txn.planId,
          status:             'ACTIVE',
          interval:           txn.interval,
          currentPeriodStart: now,
          currentPeriodEnd:   periodEnd,
          activatedAt:        now,
        },
      });
      results.push(`Created ACTIVE subscription (id: ${sub.id}, ends: ${periodEnd.toISOString().slice(0,10)})`);

      // 5. Record payment
      const exchangeRate = parseFloat(process.env.MPESA_EXCHANGE_RATE ?? '130');
      await tx.payment.create({
        data: {
          subscriptionId: sub.id,
          amountCents:    Math.round((txn.amountKes / exchangeRate) * 100),
          currency:       'KES',
          status:         'succeeded',
        },
      });
      results.push(`Recorded payment (KES ${txn.amountKes})`);

      // 6. Log the event
      await tx.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event:          'ACTIVATED',
          previousStatus: 'INCOMPLETE',
          newStatus:      'ACTIVE',
          metadata:       { via: 'mpesa_simulated', receipt: fakeReceipt, checkoutRequestId },
        },
      });
    });

    res.json({
      success: true,
      message: 'M-Pesa payment simulated. Subscription is now ACTIVE.',
      receipt: fakeReceipt,
      actions: results,
      tip: 'Your subscription page should update within 5 seconds as the poller detects COMPLETED status.',
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
