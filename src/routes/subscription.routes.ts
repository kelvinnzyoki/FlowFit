import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.middleware.js';
import { BillingInterval } from '@prisma/client';
import {
  getPlans,
  getCurrentSubscription,
  createCheckoutSession,
  cancelSubscription,
  upgradeSubscription,
  scheduleDowngrade,
  reactivateSubscription,
  getBillingPortalUrl,
  prisma,
} from '../services/subscription.service.js';
import { PLAN_HIERARCHY } from '../types/subscription.types.js';
import type { PlanSlug } from '../types/subscription.types.js';



const router = Router();

// ─── Rate limiting — billing endpoints are high-value targets ─────────────────
const billingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,
  message: { error: 'Too many billing requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,
  message: { error: 'Too many checkout attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Validators ───────────────────────────────────────────────────────────────
const validateInterval = body('interval')
  .isIn(['MONTHLY', 'YEARLY'])
  .withMessage('interval must be MONTHLY or YEARLY');

const validatePlanId = body('planId')
  .isUUID()
  .withMessage('planId must be a valid UUID');

function handleValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return false;
  }
  return true;
}

// ─── GET /subscriptions/plans ─────────────────────────────────────────────────
// Public — no auth required (used on marketing/pricing page too)
router.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await getPlans();
    res.json({ plans });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ─── GET /subscriptions/current ───────────────────────────────────────────────
router.get('/current', requireAuth, async (req: Request, res: Response) => {
  try {
    const sub = await getCurrentSubscription(req.user!.id);
    // Return null-safe: free users without a subscription get { subscription: null }
    res.json({ subscription: sub });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ─── POST /subscriptions/checkout ─────────────────────────────────────────────
// Creates a Stripe Checkout Session and returns the redirect URL.
// Subscription is NOT activated here — only after webhook confirms payment.
router.post(
  '/checkout',
  requireAuth,
  checkoutLimiter,
  [validatePlanId, validateInterval],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;

    const { planId, interval } = req.body as { planId: string; interval: BillingInterval };
    const user = req.user!;

    try {
      // Prevent downgrading via checkout — use /upgrade or /downgrade instead
      const plan = await prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } });
      if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

      const currentSub = await getCurrentSubscription(user.id);
      if (currentSub && currentSub.status === 'ACTIVE') {
        const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
        const targetRank  = PLAN_HIERARCHY[plan.slug as PlanSlug] ?? 0;
        if (targetRank <= currentRank) {
          res.status(400).json({ error: 'Use the upgrade/downgrade endpoint to change an active subscription' });
          return;
        }
      }

      // Fetch user name for Stripe customer creation
      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true },
      });

      const { url, sessionId } = await createCheckoutSession(
        user.id,
        user.email,
        dbUser?.name,
        planId,
        interval,
      );

      res.json({ checkoutUrl: url, sessionId });
    } catch (err: any) {
      const msg = err.message ?? 'Checkout failed';
      res.status(err.message?.includes('not found') ? 404 : 500).json({ error: msg });
    }
  },
);

// ─── POST /subscriptions/upgrade ──────────────────────────────────────────────
router.post(
  '/upgrade',
  requireAuth,
  billingLimiter,
  [validatePlanId, validateInterval],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;

    const { planId, interval } = req.body;
    const user = req.user!;

    try {
      const [currentSub, targetPlan] = await Promise.all([
        getCurrentSubscription(user.id),
        prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } }),
      ]);

      if (!currentSub || !['ACTIVE', 'TRIALING'].includes(currentSub.status)) {
        res.status(400).json({ error: 'No active subscription to upgrade' }); return;
      }
      if (!targetPlan) { res.status(404).json({ error: 'Plan not found' }); return; }

      const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
      const targetRank  = PLAN_HIERARCHY[targetPlan.slug as PlanSlug] ?? 0;

      if (targetRank <= currentRank) {
        res.status(400).json({ error: 'Target plan is not an upgrade. Use /downgrade for plan reductions.' });
        return;
      }

      const updated = await upgradeSubscription(
        user.id, planId, interval as BillingInterval,
        req.ip ?? undefined,
      );
      res.json({ subscription: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Upgrade failed' });
    }
  },
);

// ─── POST /subscriptions/downgrade ────────────────────────────────────────────
// Scheduled: takes effect at next billing cycle
router.post(
  '/downgrade',
  requireAuth,
  billingLimiter,
  [validatePlanId, validateInterval],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;

    const { planId, interval } = req.body;
    const user = req.user!;

    try {
      const [currentSub, targetPlan] = await Promise.all([
        getCurrentSubscription(user.id),
        prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } }),
      ]);

      if (!currentSub || !['ACTIVE', 'TRIALING'].includes(currentSub.status)) {
        res.status(400).json({ error: 'No active subscription' }); return;
      }
      if (!targetPlan) { res.status(404).json({ error: 'Plan not found' }); return; }

      const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
      const targetRank  = PLAN_HIERARCHY[targetPlan.slug as PlanSlug] ?? 0;
      if (targetRank >= currentRank) {
        res.status(400).json({ error: 'Target plan is not a downgrade. Use /upgrade.' });
        return;
      }

      const updated = await scheduleDowngrade(
        user.id, planId, interval as BillingInterval,
        req.ip ?? undefined,
      );
      res.json({ subscription: updated, message: 'Downgrade scheduled for next billing cycle' });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Downgrade failed' });
    }
  },
);

// ─── POST /subscriptions/cancel ───────────────────────────────────────────────
router.post(
  '/cancel',
  requireAuth,
  billingLimiter,
  [
    body('immediately').optional().isBoolean(),
    body('reason').optional().isString().isLength({ max: 500 }).trim(),
  ],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;

    const { immediately = false, reason } = req.body;
    try {
      const updated = await cancelSubscription(
        req.user!.id,
        immediately,
        reason,
        req.ip ?? undefined,
      );
      res.json({ subscription: updated, message: immediately ? 'Subscription cancelled' : 'Subscription will cancel at period end' });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Cancellation failed' });
    }
  },
);

// ─── POST /subscriptions/reactivate ──────────────────────────────────────────
router.post('/reactivate', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await reactivateSubscription(req.user!.id, req.ip ?? undefined);
    res.json({ subscription: updated, message: 'Subscription reactivated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Reactivation failed' });
  }
});

// ─── GET /subscriptions/billing-portal ───────────────────────────────────────
router.get('/billing-portal', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const url = await getBillingPortalUrl(req.user!.id);
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to create billing portal session' });
  }
});

export default router;
