/**
 * FLOWFIT — Subscription Routes (v4)
 *
 * FIXES APPLIED (vs v3):
 *   FIX-S2  successUrl / cancelUrl were forwarded to Stripe without validating
 *           the hostname. Any authenticated user could supply an arbitrary URL
 *           (e.g. https://evil.com) and Stripe would redirect there after checkout
 *           (open redirect / phishing vector). Added validateRedirectUrl() which
 *           rejects any URL whose hostname doesn't match FRONTEND_URL.
 *   FIX-M3  The /trial endpoint only blocked users with an *active* trial. A user
 *           could exhaust a trial, cancel, then start another. Added a historical
 *           check: if the user has ever had a trialEndsAt value set, the trial
 *           is denied (one trial per account lifetime).
 *   FIX-M4  The /trial endpoint hardcoded interval = 'MONTHLY'. Users wanting a
 *           yearly trial got a monthly one. Now reads interval from req.body,
 *           defaults to 'MONTHLY'.
 */

import { Router, Request, Response } from 'express';
import { rateLimit }                 from 'express-rate-limit';
import { body, validationResult }    from 'express-validator';
import { requireAuth }               from '../middleware/auth.middleware.js';
import { BillingInterval }           from '@prisma/client';
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
import { queryStkStatus, normalisePhone } from '../services/mpesa.service.js';
import { PLAN_HIERARCHY } from '../types/subscription.types.js';
import type { PlanSlug }  from '../types/subscription.types.js';
import prisma             from '../config/db.js';

const router = Router();

// ── Rate limiters ──────────────────────────────────────────────────────────────
const billingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many billing requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many checkout attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const mpesaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { error: 'Too many M-Pesa requests. Wait 5 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// FIX-008: Trial rate limiter (prevents trial farming attacks)
const trialLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 3, // Max 3 trial attempts per day per user
  message: { error: 'Too many trial attempts. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip, // Rate limit by user ID, fallback to IP
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX-008: TRIAL RATE LIMITER
// 
// Prevents trial abuse by limiting trial attempts to 3 per 24 hours per user.
// Even though we check for existing trials, excessive trial checks can DoS the DB.
// ═══════════════════════════════════════════════════════════════════════════
const trialLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 3,
  message: { error: 'Too many trial attempts. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip, // Rate limit by authenticated user ID
});

// ── Validators ─────────────────────────────────────────────────────────────────
const validateInterval = body('interval')
  .isIn(['MONTHLY', 'YEARLY'])
  .withMessage('interval must be MONTHLY or YEARLY');

const validatePlanId = body('planId')
  .isUUID()
  .withMessage('planId must be a valid UUID');

const validatePhone = body('phone')
  .isString()
  .notEmpty()
  .withMessage('phone is required')
  .customSanitizer((v: string) => {
    let p = v.replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.startsWith('07') || p.startsWith('01')) {
      p = '254' + p.slice(1);
    }
    return p;
  })
  .matches(/^2547\d{8}$|^2541\d{8}$/)
  .withMessage('Must be a valid Safaricom number (07XXXXXXXX or 2547XXXXXXXX)');

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return false;
  }
  return true;
}

// FIX-S2: Validate redirect URLs to prevent open redirect attacks.
// Only allow URLs whose hostname matches the configured frontend domain.
function validateRedirectUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const allowed = process.env.FRONTEND_URL || process.env.APP_URL || '';
  if (!allowed) return undefined;  // no base configured — ignore user-supplied URL
  try {
    const parsed  = new URL(url);
    const base    = new URL(allowed);
    if (parsed.hostname !== base.hostname) {
      console.warn(`[subscription] Blocked redirect URL with disallowed hostname: ${parsed.hostname}`);
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

// ─── GET /subscriptions/plans ──────────────────────────────────────────────────
router.get('/plans', async (_req, res) => {
  try {
    const plans = await getPlans();
    res.json({ success: true, data: plans });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch plans' });
  }
});

// ─── GET /subscriptions/current ───────────────────────────────────────────────
router.get('/current', requireAuth, async (req: Request, res: Response) => {
  try {
    const sub = await getCurrentSubscription(req.user!.id);
    res.json({ success: true, subscription: sub ?? null });
  } catch (err: any) {
    const msg = (err?.message ?? '').toLowerCase();
    if (msg.includes('not found') || msg.includes('no subscription') || msg.includes('no active')) {
      res.json({ success: true, subscription: null });
      return;
    }
    res.status(500).json({ success: false, error: 'Failed to fetch subscription' });
  }
});

// ─── POST /subscriptions/checkout (Stripe) ────────────────────────────────────
router.post(
  '/checkout',
  requireAuth,
  checkoutLimiter,
  [
    validatePlanId,
    validateInterval,
    body('successUrl').optional().isURL({ require_tld: false }).withMessage('successUrl must be a valid URL'),
    body('cancelUrl').optional().isURL({ require_tld: false }).withMessage('cancelUrl must be a valid URL'),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const { planId, interval, successUrl, cancelUrl } = req.body;
    const user = req.user!;

    try {
      // ═══════════════════════════════════════════════════════════════════════════
      // FIX-015: REQUIRE EMAIL VERIFICATION FOR PAID SUBSCRIPTIONS
      // 
      // Prevents users with unverified/fake emails from subscribing.
      // Benefits:
      // - Ensures we can send renewal reminders
      // - Prevents trial farming with disposable emails
      // - Ensures we can contact users about billing issues
      // ═══════════════════════════════════════════════════════════════════════════
      
      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true, isEmailVerified: true, email: true },
      });

      if (!dbUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (!dbUser.isEmailVerified) {
        return res.status(403).json({
          success: false,
          error: 'Please verify your email address before subscribing',
          action: 'verify_email',
          email: dbUser.email,
        });
      }

      const plan = await prisma.plan.findUnique({
        where: { id: planId },
        select: { slug: true },
      });
      if (!plan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const currentSub = await getCurrentSubscription(user.id).catch(() => null);

      if (currentSub && ['ACTIVE', 'TRIALING'].includes(currentSub.status)) {
        const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
        const targetRank  = PLAN_HIERARCHY[plan.slug as PlanSlug] ?? 0;
        if (targetRank <= currentRank) {
          res.status(400).json({
            error: 'Use upgrade/downgrade for an existing active subscription',
          });
          return;
        }
      }

      // FIX-S2: Validate redirect URLs before forwarding to Stripe
      const { url, sessionId } = await createCheckoutSession(
        user.id,
        user.email,
        dbUser?.name,
        planId,
        interval,
        validateRedirectUrl(successUrl),
        validateRedirectUrl(cancelUrl),
      );

      res.json({ checkoutUrl: url, sessionId });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message ?? 'Checkout failed' });
    }
  },
);

// ─── POST /subscriptions/trial ────────────────────────────────────────────────
router.post(
  '/trial',
  requireAuth,
  trialLimiter, // FIX-008: Use dedicated trial rate limiter (was billingLimiter)
  [
    validatePlanId,
    // FIX-M4: Accept interval; defaults to MONTHLY if omitted
    body('interval').optional().isIn(['MONTHLY', 'YEARLY']).withMessage('interval must be MONTHLY or YEARLY'),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const { planId, interval = 'MONTHLY' } = req.body;
    const user = req.user!;

    try {
      const plan = await prisma.plan.findUnique({
        where: { id: planId },
        select: { id: true, slug: true, name: true, trialDays: true },
      });
      if (!plan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      if (!plan.trialDays || plan.trialDays <= 0) {
        res.status(400).json({ error: 'This plan does not offer a free trial' });
        return;
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // FIX-004: COMPREHENSIVE TRIAL VALIDATION
      // 
      // Prevents trial abuse with multiple checks:
      // 1. No active subscription (blocks users trying to start trial while on paid plan)
      // 2. No previous trial (one trial per account lifetime)
      // ═══════════════════════════════════════════════════════════════════════════

      // CHECK 1: Block if currently active or trialing
      const existingSub = await getCurrentSubscription(user.id).catch(() => null);
      if (existingSub && ['ACTIVE', 'TRIALING'].includes(existingSub.status)) {
        res.status(400).json({ 
          error: 'You already have an active subscription',
          currentPlan: existingSub.plan.name,
          status: existingSub.status,
        });
        return;
      }

      // CHECK 2: FIX-M3 - Block if the user has EVER had a trial (not just currently).
      // A user who completed, cancelled, then expired a trial could previously
      // restart the trial indefinitely. One trial per account lifetime.
      const previousTrial = await prisma.subscription.findFirst({
        where: {
          userId:      user.id,
          trialEndsAt: { not: null },   // any record that ever had a trial date set
        },
      });
      if (previousTrial) {
        res.status(400).json({
          error: 'Trial already used',
          message: 'Each account is eligible for one free trial only. Please subscribe to continue.',
        });
        return;
      }

      const now         = new Date();
      const trialEndsAt = new Date(now.getTime() + plan.trialDays * 86400 * 1000);

      const subscription = await prisma.subscription.create({
        data: {
          userId:             user.id,
          planId:             plan.id,
          status:             'TRIALING',
          provider:           'STRIPE',
          interval:           interval as BillingInterval,   // FIX-M4: use body value
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd:   trialEndsAt,
          cancelAtPeriodEnd:  false,
        },
        include: { plan: true },
      });

      res.json({ success: true, subscription });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Could not start trial' });
    }
  },
);

// ─── POST /subscriptions/mpesa/initiate ───────────────────────────────────────
router.post(
  '/mpesa/initiate',
  requireAuth,
  mpesaLimiter,
  [validatePlanId, validateInterval, validatePhone],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const { planId, interval, phone } = req.body;
    const user = req.user!;

    try {
      const plan = await prisma.plan.findUnique({
        where: { id: planId },
        select: { slug: true },
      });
      if (!plan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const currentSub = await getCurrentSubscription(user.id).catch(() => null);
      if (currentSub && ['ACTIVE', 'TRIALING'].includes(currentSub.status)) {
        const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
        const targetRank  = PLAN_HIERARCHY[plan.slug as PlanSlug] ?? 0;
        if (targetRank <= currentRank) {
          res.status(400).json({
            error: 'Use upgrade/downgrade for an existing active subscription',
          });
          return;
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // FIX-009: NORMALIZE PHONE NUMBER
      // 
      // The validatePhone middleware already validates format, but we normalize here
      // to ensure consistent storage format (always 254XXXXXXXXX) in the database.
      // This prevents issues with auto-renewals where format mismatches could fail.
      // ═══════════════════════════════════════════════════════════════════════════
      const normalizedPhone = normalisePhone(phone);

      const result = await createMpesaSubscription(
        user.id,
        planId,
        interval as BillingInterval,
        normalizedPhone, // FIX-009: Pass normalized phone
      );

      res.json({
        success: true,
        message: 'STK Push sent to your phone. Enter your M-Pesa PIN to complete payment.',
        merchantRequestId: result.merchantRequestId,
        checkoutRequestId: result.checkoutRequestId,
        subscriptionId:    result.subscriptionId,
        customerMessage:   result.customerMessage,
      });
    } catch (err: any) {
      const status = err.message?.includes('phone')     ? 400
                   : err.message?.includes('not found') ? 404
                   : 500;
      res.status(status).json({ error: err.message ?? 'M-Pesa initiation failed' });
    }
  },
);

// ─── GET /subscriptions/mpesa/status/:checkoutRequestId ───────────────────────
router.get(
  '/mpesa/status/:checkoutRequestId',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 20 }),
  async (req: Request, res: Response) => {
    const { checkoutRequestId } = req.params;

    try {
      const tx = await prisma.mpesaTransaction.findUnique({
        where: { checkoutRequestId },
        select: {
          status:             true,
          mpesaReceiptNumber: true,
          resultDesc:         true,
          subscriptionId:     true,
        },
      });

      if (!tx) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      if (!tx.subscriptionId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const sub = await prisma.subscription.findUnique({
        where: { id: tx.subscriptionId },
        select: { userId: true },
      });
      if (sub?.userId !== req.user!.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (tx.status !== 'PENDING') {
        const normalisedStatus = tx.status === 'SUCCESS' ? 'COMPLETED' : tx.status;
        res.json({
          status:        normalisedStatus,
          resultDesc:    tx.resultDesc,
          receiptNumber: tx.mpesaReceiptNumber,
        });
        return;
      }

      const darajaResult = await queryStkStatus(checkoutRequestId);

      if (darajaResult.resultCode !== '17') {
        if (darajaResult.resultCode === '0') {
          const refreshed = await prisma.mpesaTransaction.findUnique({
            where: { checkoutRequestId },
            select: { status: true, mpesaReceiptNumber: true },
          });
          if (refreshed?.status === 'SUCCESS') {
            res.json({ status: 'COMPLETED', receiptNumber: refreshed.mpesaReceiptNumber });
            return;
          }
          res.json({ status: 'PENDING', resultDesc: 'Payment confirmed, activating subscription…' });
        } else {
          await prisma.mpesaTransaction.updateMany({
            where: { checkoutRequestId },
            data: {
              status:     'FAILED',
              resultCode: darajaResult.resultCode,
              resultDesc: darajaResult.resultDesc ?? null,
            },
          });
          res.json({
            status:     'FAILED',
            resultCode: darajaResult.resultCode,
            resultDesc: darajaResult.resultDesc,
          });
        }
        return;
      }

      res.json({ status: 'PENDING', resultDesc: 'Waiting for M-Pesa response' });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Status check failed' });
    }
  },
);

// ─── GET /subscriptions/payments ──────────────────────────────────────────────
router.get('/payments', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const rawPayments = await prisma.payment.findMany({
      where: {
        status:       'succeeded',
        subscription: { userId },
      },
      include: {
        subscription: {
          select: {
            plan: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take:    100,
    });

    const payments = rawPayments.map(p => ({
      createdAt:       p.createdAt,
      planName:        p.subscription?.plan?.name ?? '—',
      via:             p.stripeInvoiceId || p.stripePaymentIntentId ? 'stripe' : 'mpesa',
      amountCents:     p.amountCents,
      currency:        p.currency ?? 'USD',
      mpesaReceipt:    p.mpesaReceiptNumber ?? null,
      stripeInvoiceId: p.stripeInvoiceId ?? null,
    }));

    res.json({ success: true, payments });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to fetch payment history' });
  }
});

// ─── PUT /subscriptions/auto-renew ────────────────────────────────────────────
router.put(
  '/auto-renew',
  requireAuth,
  billingLimiter,
  [body('autoRenew').isBoolean().withMessage('autoRenew must be boolean')],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    const { autoRenew } = req.body;
    res.status(400).json({
      error: 'auto_renew_not_implemented',
      message: autoRenew
        ? 'To reactivate auto-billing for a Stripe subscription, use POST /subscriptions/reactivate.'
        : 'To stop auto-billing for a Stripe subscription, use POST /subscriptions/cancel with { "immediately": false }.',
    });
  },
);

// ─── POST /subscriptions/upgrade ──────────────────────────────────────────────
router.post(
  '/upgrade',
  requireAuth,
  billingLimiter,
  [validatePlanId, validateInterval],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const { planId, interval } = req.body;
    const user = req.user!;

    try {
      const [currentSub, targetPlan] = await Promise.all([
        getCurrentSubscription(user.id).catch(() => null),
        prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } }),
      ]);

      if (!currentSub || !['ACTIVE', 'TRIALING'].includes(currentSub.status)) {
        res.status(400).json({ error: 'No active subscription to upgrade' });
        return;
      }
      if (!targetPlan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
      const targetRank  = PLAN_HIERARCHY[targetPlan.slug as PlanSlug] ?? 0;

      if (targetRank <= currentRank) {
        res.status(400).json({ error: 'Target plan is not an upgrade. Use /downgrade.' });
        return;
      }

      if ((currentSub as any).provider === 'MPESA') {
        res.status(400).json({
          error: 'M-Pesa upgrades require a new payment. Use /mpesa/initiate with the new plan.',
          code:  'MPESA_USE_INITIATE',
        });
        return;
      }

      const updated = await upgradeSubscription(user.id, planId, interval as BillingInterval, req.ip ?? undefined);
      res.json({ success: true, subscription: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Upgrade failed' });
    }
  },
);

// ─── POST /subscriptions/downgrade ────────────────────────────────────────────
router.post(
  '/downgrade',
  requireAuth,
  billingLimiter,
  [validatePlanId, validateInterval],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const { planId, interval } = req.body;
    const user = req.user!;

    try {
      const [currentSub, targetPlan] = await Promise.all([
        getCurrentSubscription(user.id).catch(() => null),
        prisma.plan.findUnique({ where: { id: planId }, select: { slug: true } }),
      ]);

      if (!currentSub || !['ACTIVE', 'TRIALING'].includes(currentSub.status)) {
        res.status(400).json({ error: 'No active subscription to downgrade' });
        return;
      }
      if (!targetPlan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const currentRank = PLAN_HIERARCHY[currentSub.plan.slug as PlanSlug] ?? 0;
      const targetRank  = PLAN_HIERARCHY[targetPlan.slug as PlanSlug] ?? 0;

      if (targetRank >= currentRank) {
        res.status(400).json({ error: 'Target plan is not a downgrade. Use /upgrade.' });
        return;
      }

      const updated = await scheduleDowngrade(user.id, planId, interval as BillingInterval, req.ip ?? undefined);
      res.json({ success: true, subscription: updated, message: 'Downgrade scheduled for next billing cycle' });
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
    if (!validate(req, res)) return;

    const { immediately = false, reason } = req.body;
    try {
      const updated = await cancelSubscription(req.user!.id, immediately, reason, req.ip ?? undefined);
      res.json({
        success: true,
        subscription: updated,
        message: immediately
          ? 'Subscription cancelled immediately'
          : 'Subscription will cancel at period end — no further charges will be made',
      });
    } catch (err: any) {
      const status = err.message?.includes('not found') || err.message?.includes('no active') ? 404 : 500;
      res.status(status).json({ error: err.message ?? 'Cancellation failed' });
    }
  },
);

// ─── POST /subscriptions/reactivate ───────────────────────────────────────────
router.post('/reactivate', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await reactivateSubscription(req.user!.id, req.ip ?? undefined);
    res.json({ success: true, subscription: updated, message: 'Subscription reactivated. Billing will resume as scheduled.' });
  } catch (err: any) {
    const status = err.message?.includes('not found') || err.message?.includes('no active') ? 404 : 500;
    res.status(status).json({ error: err.message ?? 'Reactivation failed' });
  }
});

// ─── GET /subscriptions/billing-portal ────────────────────────────────────────
router.get('/billing-portal', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const url = await getBillingPortalUrl(req.user!.id);
    res.json({ success: true, url });
  } catch (err: any) {
    const msg = (err?.message ?? '').toLowerCase();
    if (msg.includes('mpesa') || msg.includes('no customer') || msg.includes('no billing')) {
      res.status(400).json({ error: 'mpesa_no_billing_portal', message: 'Billing portal is only available for Stripe subscriptions.' });
      return;
    }
    res.status(500).json({ error: err.message ?? 'Failed to create billing portal session' });
  }
});

export default router;
