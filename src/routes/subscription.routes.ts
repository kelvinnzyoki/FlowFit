/**
 * FLOWFIT — Subscription Routes (v2)
 * Adds M-Pesa initiation on top of existing Stripe endpoints.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { body, query, param, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.middleware.js';
import { BillingInterval } from '@prisma/client';
import {
  getPlans,
  getCurrentSubscription,
  createCheckoutSession,
  createMpesaSubscription,
  cancelSubscription,
  upgradeSubscription,
  scheduleDowngrade,
  reactivateSubscription,
  getBillingPortalUrl,
} from '../services/subscription.service.js';
import { queryStkStatus } from '../services/mpesa.service.js';
import { PLAN_HIERARCHY } from '../types/subscription.types.js';
import type { PlanSlug } from '../types/subscription.types.js';
import prisma from '../config/db.js';

const router = Router();

// ── Rate limiters ──────────────────────────────────────────────────────────────
const billingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many billing requests. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many checkout attempts. Please try again in an hour.' },
  standardHeaders: true, legacyHeaders: false,
});

const mpesaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 3,
  message: { error: 'Too many M-Pesa requests. Wait 5 minutes before trying again.' },
  standardHeaders: true, legacyHeaders: false,
});

// ── Validators ─────────────────────────────────────────────────────────────────
const validateInterval = body('interval')
  .isIn(['MONTHLY', 'YEARLY']).withMessage('interval must be MONTHLY or YEARLY');

const validatePlanId = body('planId')
  .isUUID().withMessage('planId must be a valid UUID');

const validatePhone = body('phone')
  .isString().notEmpty()
  .withMessage('phone is required')
  .customSanitizer((v: string) => v.replace(/\s/g, ''))
  .matches(/^(\+?254|0)7\d{8}$/).withMessage('Must be a valid Kenyan mobile number (07XXXXXXXX or 2547XXXXXXXX)');

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return false;
  }
  return true;
}

// ─── GET /subscriptions/plans ──────────────────────────────────────────────────
router.get('/plans', async (_req, res) => {
  try {
    const plans = await getPlans();
    res.json({ plans });
  } catch {
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ─── GET /subscriptions/current ───────────────────────────────────────────────
router.get('/current', requireAuth, async (req, res) => {
  try {
    const sub = await getCurrentSubscription(req.user!.id);
    res.json({ subscription: sub });
  } catch {
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ─── POST /subscriptions/checkout (Stripe) ────────────────────────────────────
router.post(
  '/checkout',
  requireAuth, checkoutLimiter, [validatePlanId, validateInterval],
  async (req, res) => {
    if (!validate(req, res)) return;
    const { planId, interval } = req.body;
    const user = req.user!;

    try {
      const plan = await prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } });
      if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

      const currentSub = await getCurrentSubscription(user.id);
      if (currentSub && currentSub.status === 'ACTIVE') {
        const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
        const targetRank  = PLAN_HIERARCHY[plan.slug as PlanSlug] ?? 0;
        if (targetRank <= currentRank) {
          res.status(400).json({ error: 'Use upgrade/downgrade for an existing active subscription' });
          return;
        }
      }

      const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
      const { url, sessionId } = await createCheckoutSession(user.id, user.email, dbUser?.name, planId, interval);
      res.json({ checkoutUrl: url, sessionId });
    } catch (err: any) {
      res.status(err.message?.includes('not found') ? 404 : 500).json({ error: err.message ?? 'Checkout failed' });
    }
  },
);

// ─── POST /subscriptions/mpesa/initiate ───────────────────────────────────────
// Initiate M-Pesa STK Push for a new subscription.
// Returns immediately — actual activation happens via /api/webhooks/mpesa/callback
router.post(
  '/mpesa/initiate',
  requireAuth, mpesaLimiter, [validatePlanId, validateInterval, validatePhone],
  async (req, res) => {
    if (!validate(req, res)) return;

    const { planId, interval, phone } = req.body;
    const user = req.user!;

    try {
      // Block if user already has an active subscription of the same or higher tier
      const plan = await prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } });
      if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

      const currentSub = await getCurrentSubscription(user.id);
      if (currentSub && currentSub.status === 'ACTIVE') {
        const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
        const targetRank  = PLAN_HIERARCHY[plan.slug as PlanSlug] ?? 0;
        if (targetRank <= currentRank) {
          res.status(400).json({ error: 'Use upgrade/downgrade for an existing active subscription' });
          return;
        }
      }

      const result = await createMpesaSubscription(user.id, planId, interval as BillingInterval, phone);

      res.json({
        success: true,
        message: 'STK Push sent to your phone. Enter your M-Pesa PIN to complete payment.',
        merchantRequestId: result.merchantRequestId,
        checkoutRequestId: result.checkoutRequestId,
        subscriptionId:    result.subscriptionId,
        customerMessage:   result.customerMessage,
      });
    } catch (err: any) {
      const status = err.message?.includes('phone') ? 400
                   : err.message?.includes('not found') ? 404
                   : 500;
      res.status(status).json({ error: err.message ?? 'M-Pesa initiation failed' });
    }
  },
);

// ─── GET /subscriptions/mpesa/status/:checkoutRequestId ───────────────────────
// Poll STK Push status — use when callback wasn't received (fallback polling).
// Frontend polls this every 5s for up to 90s after initiating STK Push.
router.get(
  '/mpesa/status/:checkoutRequestId',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 20 }),
  async (req, res) => {
    const { checkoutRequestId } = req.params;

    try {
      // Check our DB first (fastest path — callback may have arrived)
      const tx = await prisma.mpesaTransaction.findUnique({
        where: { checkoutRequestId },
        select: { status: true, mpesaReceiptNumber: true, resultDesc: true, subscriptionId: true },
      });

      if (!tx) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      // Verify the transaction belongs to this user
      const sub = await prisma.subscription.findUnique({
        where: { id: tx.subscriptionId },
        select: { userId: true },
      });
      if (sub?.userId !== req.user!.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (tx.status !== 'PENDING') {
        // Already resolved — return DB result
        res.json({
          status: tx.status,
          resultDesc: tx.resultDesc,
          receiptNumber: tx.mpesaReceiptNumber,
        });
        return;
      }

      // Still pending — query Daraja directly
      const darajaResult = await queryStkStatus(checkoutRequestId);

      // If Daraja has a result, update the DB
      if (darajaResult.resultCode !== '17') {  // 17 = still processing
        const { handleMpesaSuccess, handleMpesaFailure } = await import('../services/subscription.service.js');
        if (darajaResult.resultCode === '0') {
          // Receipt comes from the callback, not the query — we'll wait for callback
          res.json({ status: 'SUCCESS_PENDING_CALLBACK', resultCode: darajaResult.resultCode });
        } else {
          await handleMpesaFailure(checkoutRequestId, darajaResult.resultCode, darajaResult.resultDesc);
          res.json({ status: 'FAILED', resultCode: darajaResult.resultCode, resultDesc: darajaResult.resultDesc });
        }
        return;
      }

      res.json({ status: 'PENDING', resultDesc: 'Waiting for M-Pesa response' });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Status check failed' });
    }
  },
);

// ─── PUT /subscriptions/auto-renew ────────────────────────────────────────────
// Toggle auto-renew for M-Pesa subscriptions.
router.put(
  '/auto-renew',
  requireAuth,
  billingLimiter,
  [body('autoRenew').isBoolean().withMessage('autoRenew must be boolean')],
  async (req, res) => {
    if (!validate(req, res)) return;

    const { autoRenew } = req.body;
    try {
      const sub = await prisma.subscription.findFirst({
        where: { userId: req.user!.id, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD'] } },
        orderBy: { createdAt: 'desc' },
      });

      if (!sub) { res.status(404).json({ error: 'No active subscription' }); return; }

      if (sub.provider !== 'MPESA') {
        res.status(400).json({ error: 'Auto-renew toggle is for M-Pesa subscriptions. Use the billing portal for Stripe.' });
        return;
      }

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { autoRenew },
      });

      res.json({
        success: true,
        autoRenew,
        message: autoRenew ? 'Auto-renew enabled' : 'Auto-renew disabled. Your subscription will expire at the end of the billing period.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Failed to update auto-renew' });
    }
  },
);

// ─── POST /subscriptions/upgrade ──────────────────────────────────────────────
router.post(
  '/upgrade',
  requireAuth, billingLimiter, [validatePlanId, validateInterval],
  async (req, res) => {
    if (!validate(req, res)) return;
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
        res.status(400).json({ error: 'Target plan is not an upgrade. Use /downgrade.' }); return;
      }

      // M-Pesa upgrades require new STK push — redirect to mpesa/initiate
      if ((currentSub as any).provider === 'MPESA') {
        res.status(400).json({
          error: 'M-Pesa upgrades require a new payment. Use /mpesa/initiate with the new plan.',
          code: 'MPESA_USE_INITIATE',
        });
        return;
      }

      const updated = await upgradeSubscription(user.id, planId, interval as BillingInterval, req.ip ?? undefined);
      res.json({ subscription: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Upgrade failed' });
    }
  },
);

// ─── POST /subscriptions/downgrade ────────────────────────────────────────────
router.post(
  '/downgrade',
  requireAuth, billingLimiter, [validatePlanId, validateInterval],
  async (req, res) => {
    if (!validate(req, res)) return;
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
        res.status(400).json({ error: 'Target plan is not a downgrade. Use /upgrade.' }); return;
      }

      const updated = await scheduleDowngrade(user.id, planId, interval as BillingInterval, req.ip ?? undefined);
      res.json({ subscription: updated, message: 'Downgrade scheduled for next billing cycle' });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Downgrade failed' });
    }
  },
);

// ─── POST /subscriptions/cancel ───────────────────────────────────────────────
router.post(
  '/cancel',
  requireAuth, billingLimiter,
  [body('immediately').optional().isBoolean(), body('reason').optional().isString().isLength({ max: 500 }).trim()],
  async (req, res) => {
    if (!validate(req, res)) return;
    const { immediately = false, reason } = req.body;
    try {
      const updated = await cancelSubscription(req.user!.id, immediately, reason, req.ip ?? undefined);
      res.json({
        subscription: updated,
        message: immediately ? 'Subscription cancelled immediately' : 'Subscription will cancel at period end',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Cancellation failed' });
    }
  },
);

// ─── POST /subscriptions/reactivate ───────────────────────────────────────────
router.post('/reactivate', requireAuth, billingLimiter, async (req, res) => {
  try {
    const updated = await reactivateSubscription(req.user!.id, req.ip ?? undefined);
    res.json({ subscription: updated, message: 'Subscription reactivated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Reactivation failed' });
  }
});

// ─── GET /subscriptions/billing-portal ────────────────────────────────────────
router.get('/billing-portal', requireAuth, billingLimiter, async (req, res) => {
  try {
    const url = await getBillingPortalUrl(req.user!.id);
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to create billing portal session' });
  }
});

export default router;
