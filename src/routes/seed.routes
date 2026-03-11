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

export default router;
