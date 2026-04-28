/**
 * FLOWFIT — Subscription Routes (v5 — Paystack)
 *
 * CHANGES FROM v4 (Stripe → Paystack):
 *   1. POST /checkout        — replaced Stripe Checkout Session with Paystack
 *                              transaction initialization. Returns authorizationUrl
 *                              + reference instead of a Stripe checkout URL.
 *   2. GET  /paystack/verify/:reference  — NEW. Frontend hits this after Paystack
 *                              redirects to callbackUrl so the backend can verify
 *                              the transaction and activate the subscription.
 *   3. GET  /billing-portal  — Paystack has no hosted billing portal.
 *                              Returns the in-app subscription page URL.
 *   4. POST /trial           — provider changed from 'STRIPE' to 'PAYSTACK'.
 *   5. POST /upgrade         — provider guard updated (MPESA guard kept,
 *                              Stripe-only guard removed).
 *   6. PUT  /auto-renew      — error messages updated to reference Paystack.
 *   7. GET  /payments        — via detection uses paystackReference instead of
 *                              stripeInvoiceId / stripePaymentIntentId.
 *   8. validateRedirectUrl   — renamed validateCallbackUrl, same hostname check.
 *
 * Preserved exactly:
 *   - All M-Pesa endpoints and logic
 *   - All rate limiters and their limits
 *   - All validators (phone, planId, interval)
 *   - All business-logic guards (trial abuse, plan hierarchy, email verification)
 *   - All FIX-* comments and their protections
 */

import { Router, Request, Response } from 'express';
import { rateLimit }                  from 'express-rate-limit';
import { body, validationResult }     from 'express-validator';
import { authenticate as requireAuth } from '../middleware/auth.middleware.js';
import { BillingInterval }            from '@prisma/client';
import {
  getPlans,
  getCurrentSubscription,
  createPaystackCheckout,
  createMpesaSubscription,
  cancelSubscription,
  upgradeSubscription,
  scheduleDowngrade,
  reactivateSubscription,
} from '../services/subscription.service.js';
import { verifyPaystackPayment }      from '../services/paystack.service.js';
import { queryStkStatus, normalisePhone } from '../services/mpesa.service.js';
import { PLAN_HIERARCHY }             from '../types/subscription.types.js';
import type { PlanSlug }              from '../types/subscription.types.js';
import prisma                         from '../config/db.js';

const router = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────
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
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many trial attempts. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id || req.ip || 'anonymous',
});

// ── Validators ────────────────────────────────────────────────────────────────
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

// FIX-S2 (preserved): Validate callback URL to prevent open redirect attacks.
// Renamed from validateRedirectUrl — same hostname-matching logic applies.
function validateCallbackUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const allowed = process.env.FRONTEND_URL || process.env.APP_URL || '';
  if (!allowed) return undefined;
  try {
    const parsed = new URL(url);
    const base   = new URL(allowed);
    if (parsed.hostname !== base.hostname) {
      console.warn(`[subscription] Blocked callback URL with disallowed hostname: ${parsed.hostname}`);
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

// ─── GET /subscriptions/plans ─────────────────────────────────────────────────
router.get('/plans', async (_req, res) => {
  try {
    const plans = await getPlans();
    res.json({ success: true, data: plans });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch plans' });
  }
});

// ─── GET /subscriptions/current ──────────────────────────────────────────────
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

// ─── POST /subscriptions/checkout (Paystack) ──────────────────────────────────
//
// Initializes a Paystack transaction and returns the authorization URL.
// Frontend redirects the user to authorizationUrl; after payment Paystack
// redirects back to callbackUrl (or the dashboard-configured URL if omitted).
// Frontend then calls GET /paystack/verify/:reference to confirm activation.
router.post(
  '/checkout',
  requireAuth,
  checkoutLimiter,
  [
    validatePlanId,
    validateInterval,
    body('callbackUrl')
      .optional()
      .isURL({ require_tld: false })
      .withMessage('callbackUrl must be a valid URL'),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const { planId, interval, callbackUrl } = req.body;
    const user = req.user!;

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // FIX-015: REQUIRE EMAIL VERIFICATION FOR PAID SUBSCRIPTIONS
      // ═══════════════════════════════════════════════════════════════════════
      const dbUser = await prisma.user.findUnique({
        where:  { id: user.id },
        select: { name: true, isEmailVerified: true, email: true },
      });

      if (!dbUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      if (!dbUser.isEmailVerified) {
        res.status(403).json({
          success: false,
          error:   'Please verify your email address before subscribing',
          action:  'verify_email',
          email:   dbUser.email,
        });
        return;
      }

      const plan = await prisma.plan.findUnique({
        where:  { id: planId },
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

      // FIX-S2 (preserved): Validate callback URL before forwarding to Paystack
      const { authorizationUrl, reference, accessCode } = await createPaystackCheckout(
        user.id,
        user.email,
        dbUser.name,
        planId,
        interval,
        validateCallbackUrl(callbackUrl),
      );

      res.json({ success: true, authorizationUrl, reference, accessCode });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message ?? 'Checkout failed' });
    }
  },
);

// ─── GET /subscriptions/paystack/verify/:reference ───────────────────────────
//
// Called by the frontend after Paystack redirects back to callbackUrl.
// Verifies the transaction against Paystack's API and activates the
// subscription if payment succeeded.
router.get(
  '/paystack/verify/:reference',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  async (req: Request, res: Response) => {
    const { reference } = req.params;

    try {
      const result = await verifyPaystackPayment(reference, req.user!.id);

      if (!result.success) {
        res.status(400).json({
          success: false,
          status:  result.status,
          message: result.message ?? 'Payment could not be verified',
        });
        return;
      }

      res.json({
        success:      true,
        status:       result.status,
        subscription: result.subscription,
        message:      'Payment verified. Subscription is now active.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Verification failed' });
    }
  },
);

// ─── POST /subscriptions/trial ───────────────────────────────────────────────
router.post(
  '/trial',
  requireAuth,
  trialLimiter, // FIX-008
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
        where:  { id: planId },
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

      // ═══════════════════════════════════════════════════════════════════════
      // FIX-004: COMPREHENSIVE TRIAL VALIDATION
      // CHECK 1: Block if currently active or trialing
      // ═══════════════════════════════════════════════════════════════════════
      const existingSub = await getCurrentSubscription(user.id).catch(() => null);
      if (existingSub && ['ACTIVE', 'TRIALING'].includes(existingSub.status)) {
        res.status(400).json({
          error:       'You already have an active subscription',
          currentPlan: existingSub.plan.name,
          status:      existingSub.status,
        });
        return;
      }

      // CHECK 2: FIX-M3 — Block if the user has EVER had a trial (one per lifetime)
      const previousTrial = await prisma.subscription.findFirst({
        where: { userId: user.id, trialEndsAt: { not: null } },
      });
      if (previousTrial) {
        res.status(400).json({
          error:   'Trial already used',
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
          provider:           'PAYSTACK',
          interval:           interval as BillingInterval,
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

// ─── POST /subscriptions/mpesa/initiate ──────────────────────────────────────
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
        where:  { id: planId },
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

      // FIX-009: Normalize phone number before storage
      const normalizedPhone = normalisePhone(phone);

      const result = await createMpesaSubscription(
        user.id,
        planId,
        interval as BillingInterval,
        normalizedPhone,
      );

      res.json({
        success:           true,
        message:           'STK Push sent to your phone. Enter your M-Pesa PIN to complete payment.',
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

// ─── GET /subscriptions/mpesa/status/:checkoutRequestId ──────────────────────
router.get(
  '/mpesa/status/:checkoutRequestId',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 20 }),
  async (req: Request, res: Response) => {
    const { checkoutRequestId } = req.params;

    try {
      const tx = await prisma.mpesaTransaction.findUnique({
        where:  { checkoutRequestId },
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
        where:  { id: tx.subscriptionId },
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
            where:  { checkoutRequestId },
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

// ─── GET /subscriptions/payments ─────────────────────────────────────────────
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
      createdAt:          p.createdAt,
      planName:           p.subscription?.plan?.name ?? '—',
      via:                p.paystackReference ? 'paystack' : 'mpesa',
      amountCents:        p.amountCents,
      currency:           p.currency ?? 'KES',
      mpesaReceipt:       p.mpesaReceiptNumber  ?? null,
      paystackReference:  p.paystackReference   ?? null,
    }));

    res.json({ success: true, payments });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to fetch payment history' });
  }
});

// ─── PUT /subscriptions/auto-renew ───────────────────────────────────────────
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
        ? 'To reactivate auto-billing for a Paystack subscription, use POST /subscriptions/reactivate.'
        : 'To stop auto-billing for a Paystack subscription, use POST /subscriptions/cancel with { "immediately": false }.',
    });
  },
);

// ─── POST /subscriptions/upgrade ─────────────────────────────────────────────
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

      // M-Pesa subscriptions require a new STK push for any plan change
      if ((currentSub as any).provider === 'MPESA') {
        res.status(400).json({
          error: 'M-Pesa upgrades require a new payment. Use /mpesa/initiate with the new plan.',
          code:  'MPESA_USE_INITIATE',
        });
        return;
      }

      const result = await upgradeSubscription(user.id, planId, interval as BillingInterval, req.ip ?? undefined);

      // upgradeSubscription returns CurrentSubscription for M-Pesa DB-only upgrades.
      // For Paystack subs it throws PAYSTACK_NEW_CHECKOUT_REQUIRED (see catch below).
      res.json({ success: true, subscription: result });
    } catch (err: any) {
      // Paystack upgrades cannot be done in-place — a new checkout is required.
      // Return a structured 402 so the frontend can redirect to /checkout.
      if (err.message?.startsWith('PAYSTACK_NEW_CHECKOUT_REQUIRED')) {
        res.status(402).json({
          success: false,
          code:    'PAYSTACK_NEW_CHECKOUT_REQUIRED',
          planId,
          interval,
          message: 'A new payment is required to upgrade. Please complete checkout for the new plan.',
          action:  'redirect_to_checkout',
        });
        return;
      }
      res.status(500).json({ error: err.message ?? 'Upgrade failed' });
    }
  },
);

// ─── POST /subscriptions/downgrade ───────────────────────────────────────────
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

// ─── POST /subscriptions/cancel ──────────────────────────────────────────────
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
        success:      true,
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

// ─── POST /subscriptions/reactivate ──────────────────────────────────────────
router.post('/reactivate', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await reactivateSubscription(req.user!.id, req.ip ?? undefined);
    res.json({
      success:      true,
      subscription: updated,
      message:      'Subscription reactivated. Billing will resume as scheduled.',
    });
  } catch (err: any) {
    const status = err.message?.includes('not found') || err.message?.includes('no active') ? 404 : 500;
    res.status(status).json({ error: err.message ?? 'Reactivation failed' });
  }
});

// ─── GET /subscriptions/billing-portal ───────────────────────────────────────
//
// Paystack does not offer a hosted billing portal.
// Returns the in-app subscription management URL so the frontend can redirect
// the user without changing its existing billing-portal call pattern.
router.get('/billing-portal', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  const appUrl = (process.env.FRONTEND_URL || process.env.APP_URL || '').replace(/\/$/, '');
  res.json({
    success: true,
    url:     `${appUrl}/subscription.html`,
    note:    'Manage your subscription directly in the app.',
  });
});

export default router;
