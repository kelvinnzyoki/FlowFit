/**
 * FLOWFIT — Subscription Routes (v3)
 *
 * Fixes applied vs v2:
 *  1. GET  /plans            — response shape { success, data } to match frontend expectation
 *  2. GET  /current          — return { success, subscription: null } (not 500) when no sub exists
 *  3. POST /checkout         — pass successUrl + cancelUrl from req.body to createCheckoutSession
 *  4. POST /checkout         — block TRIALING users from opening a duplicate checkout
 *  5. GET  /mpesa/status/:id — normalise DB status 'SUCCESS' → 'COMPLETED' for frontend polling
 *  6. POST /trial            — new endpoint (was missing; frontend calls it in startFreeTrial)
 *  7. GET  /payments         — new endpoint (was missing; frontend calls it in renderBillingHistory)
 *  8. validatePhone          — sanitise +254 / 07 → 2547 before Daraja receives the number
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
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
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many billing requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many checkout attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const mpesaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { error: 'Too many M-Pesa requests. Wait 5 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Validators ─────────────────────────────────────────────────────────────────
const validateInterval = body('interval')
  .isIn(['MONTHLY', 'YEARLY'])
  .withMessage('interval must be MONTHLY or YEARLY');

const validatePlanId = body('planId')
  .isUUID()
  .withMessage('planId must be a valid UUID');

/**
 * FIX 8 — validatePhone
 * Previous sanitiser only stripped spaces. Daraja requires the number in
 * E.164 without the '+' prefix (2547XXXXXXXX). Added normalisation step so
 * users can send 07…, +2547…, or 2547… and the correct value reaches Daraja.
 */
const validatePhone = body('phone')
  .isString()
  .notEmpty()
  .withMessage('phone is required')
  .customSanitizer((v: string) => {
    // Strip all whitespace, dashes, parentheses
    let p = v.replace(/[\s\-\(\)]/g, '');
    // Remove leading + if present
    if (p.startsWith('+')) p = p.slice(1);
    // Convert 07XXXXXXXX or 01XXXXXXXX → 2547XXXXXXXX / 2541XXXXXXXX
    if (p.startsWith('07') || p.startsWith('01')) {
      p = '254' + p.slice(1);
    }
    return p;
  })
  // After normalisation the only valid shape is 2547XXXXXXXX or 2541XXXXXXXX
  .matches(/^2547\d{8}$|^2541\d{8}$/)
  .withMessage('Must be a valid Safaricom number (07XXXXXXXX or 2547XXXXXXXX)');

/** Run express-validator and send 400 if anything failed. Returns true if valid. */
function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return false;
  }
  return true;
}

// ─── GET /subscriptions/plans ──────────────────────────────────────────────────
/**
 * FIX 1 — Response shape
 * Was:  { plans: [...] }
 * Now:  { success: true, data: [...] }
 *
 * The frontend reads plansRes.value?.data and checks plansRes.value?.success.
 * The old shape meant plansData was always undefined, plansFromAPI stayed false,
 * and every checkout button fell back to static-* IDs that fail UUID validation.
 */
router.get('/plans', async (_req, res) => {
  try {
    const plans = await getPlans();
    res.json({ success: true, data: plans });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch plans' });
  }
});

// ─── GET /subscriptions/current ───────────────────────────────────────────────
/**
 * FIX 2 — No-subscription case
 * Was:  errors thrown by the service (e.g. "no subscription") propagated as 500,
 *       causing the frontend to treat all auth users as errored rather than free.
 * Now:  if the service returns null or throws "not found", respond with
 *       { success: true, subscription: null } so the frontend sets currentSub = null.
 *
 * The frontend checks:
 *   const subData = raw?.data ?? raw?.subscription ?? null;
 * so both { subscription: null } and { data: null } work; we keep the existing
 * { subscription: ... } key for backward compat.
 */
router.get('/current', requireAuth, async (req, res) => {
  try {
    const sub = await getCurrentSubscription(req.user!.id);
    res.json({ success: true, subscription: sub ?? null });
  } catch (err: any) {
    // "not found" / "no subscription" is not a server error — user is simply on free tier
    const msg = (err?.message ?? '').toLowerCase();
    if (msg.includes('not found') || msg.includes('no subscription') || msg.includes('no active')) {
      res.json({ success: true, subscription: null });
      return;
    }
    res.status(500).json({ success: false, error: 'Failed to fetch subscription' });
  }
});

// ─── POST /subscriptions/checkout (Stripe) ────────────────────────────────────
/**
 * FIX 3 — successUrl / cancelUrl ignored
 * The frontend sends both URLs in the request body so Stripe redirects back to
 * the correct frontend page after payment. Previously these were extracted from
 * req.body but never forwarded to createCheckoutSession — the service fell back
 * to APP_URL (the API server), producing a 404 after payment.
 *
 * FIX 4 — TRIALING users could open a duplicate checkout
 * Was:  only blocked ACTIVE users
 * Now:  blocks ACTIVE and TRIALING users (use /upgrade instead)
 *
 * NOTE: createCheckoutSession in subscription.service.ts must accept and use
 * the successUrl / cancelUrl parameters added here. Update its signature to:
 *   createCheckoutSession(userId, email, name, planId, interval, successUrl?, cancelUrl?)
 * and pass them as success_url / cancel_url to stripe.checkout.sessions.create().
 */
router.post(
  '/checkout',
  requireAuth,
  checkoutLimiter,
  [
    validatePlanId,
    validateInterval,
    // Optional — if omitted the service falls back to FRONTEND_URL env var
    body('successUrl').optional().isURL({ require_tld: false }).withMessage('successUrl must be a valid URL'),
    body('cancelUrl').optional().isURL({ require_tld: false }).withMessage('cancelUrl must be a valid URL'),
  ],
  async (req, res) => {
    if (!validate(req, res)) return;

    const { planId, interval, successUrl, cancelUrl } = req.body;
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

      // FIX 4: block ACTIVE and TRIALING — both indicate an existing live subscription
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

      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true },
      });

      // FIX 3: forward successUrl / cancelUrl to the service so Stripe uses them
      const { url, sessionId } = await createCheckoutSession(
        user.id,
        user.email,
        dbUser?.name,
        planId,
        interval,
        successUrl,   // ← NEW: passed to stripe.checkout.sessions.create({ success_url })
        cancelUrl,    // ← NEW: passed to stripe.checkout.sessions.create({ cancel_url })
      );

      res.json({ checkoutUrl: url, sessionId });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message ?? 'Checkout failed' });
    }
  },
);

// ─── POST /subscriptions/trial ────────────────────────────────────────────────
/**
 * FIX 6 — Missing endpoint
 * The frontend calls POST /subscriptions/trial in startFreeTrial(planId).
 * It expects back { subscription: <sub object> } or { data: <sub object> }.
 *
 * Creates a TRIALING subscription directly without requiring payment.
 * Only allowed when the plan has trialDays > 0 and the user has no active sub.
 */
router.post(
  '/trial',
  requireAuth,
  billingLimiter,
  [validatePlanId],
  async (req, res) => {
    if (!validate(req, res)) return;

    const { planId } = req.body;
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

      // Block if user already has or had an active/trialing subscription
      const existingSub = await getCurrentSubscription(user.id).catch(() => null);
      if (existingSub && ['ACTIVE', 'TRIALING'].includes(existingSub.status)) {
        res.status(400).json({ error: 'You already have an active subscription' });
        return;
      }

      // Cancel any previous cancelled/expired sub so there is only one record
      await prisma.subscription.updateMany({
        where: { userId: user.id, status: { in: ['CANCELLED', 'EXPIRED'] } },
        data: { status: 'EXPIRED' },
      });

      const now          = new Date();
      const trialEndsAt  = new Date(now.getTime() + plan.trialDays * 86400 * 1000);

      const subscription = await prisma.subscription.create({
        data: {
          userId:           user.id,
          planId:           plan.id,
          status:           'TRIALING',
          provider:         'STRIPE',  // trial converts via Stripe when user adds card
          billingInterval:  'MONTHLY',
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
// Initiate M-Pesa STK Push for a new subscription.
// Returns immediately — actual activation happens via /api/webhooks/mpesa/callback
router.post(
  '/mpesa/initiate',
  requireAuth,
  mpesaLimiter,
  [validatePlanId, validateInterval, validatePhone],
  async (req, res) => {
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

      const result = await createMpesaSubscription(
        user.id,
        planId,
        interval as BillingInterval,
        phone,
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
/**
 * FIX 5 — Status normalisation
 * Was:  returned { status: tx.status } where DB stores 'SUCCESS'
 * Now:  maps 'SUCCESS' → 'COMPLETED' because the frontend polls for
 *       res?.status === 'COMPLETED' to detect payment confirmation.
 *
 * Without this fix the M-Pesa payment completes on the server and in the DB
 * but the frontend polling loop never fires the success branch, leaving the
 * user stuck on the "Waiting for payment" screen with an already-active sub.
 */
router.get(
  '/mpesa/status/:checkoutRequestId',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 20 }),
  async (req, res) => {
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
        // FIX 5: normalise DB status value to the string the frontend checks
        // DB stores 'SUCCESS'; frontend polls for 'COMPLETED'
        const normalisedStatus = tx.status === 'SUCCESS' ? 'COMPLETED' : tx.status;
        res.json({
          status:        normalisedStatus,
          resultDesc:    tx.resultDesc,
          receiptNumber: tx.mpesaReceiptNumber,
        });
        return;
      }

      // Still PENDING in DB — query Daraja directly for the latest result
      const darajaResult = await queryStkStatus(checkoutRequestId);

      if (darajaResult.resultCode !== '17') {
        // 17 = still processing; any other code is a terminal result
        const { handleMpesaSuccess, handleMpesaFailure } =
          await import('../services/subscription.service.js');

        if (darajaResult.resultCode === '0') {
          // Daraja says success but callback hasn't arrived yet.
          // Re-check DB one more time — callback may have just landed.
          const refreshed = await prisma.mpesaTransaction.findUnique({
            where: { checkoutRequestId },
            select: { status: true, mpesaReceiptNumber: true },
          });
          if (refreshed?.status === 'SUCCESS') {
            res.json({ status: 'COMPLETED', receiptNumber: refreshed.mpesaReceiptNumber });
            return;
          }
          // Callback genuinely hasn't arrived — tell frontend to keep polling briefly
          res.json({ status: 'PENDING', resultDesc: 'Payment confirmed, activating subscription…' });
        } else {
          // Terminal failure — persist it and tell the frontend
          await handleMpesaFailure(
            checkoutRequestId,
            darajaResult.resultCode,
            darajaResult.resultDesc,
          );
          res.json({
            status:     'FAILED',
            resultCode: darajaResult.resultCode,
            resultDesc: darajaResult.resultDesc,
          });
        }
        return;
      }

      // resultCode 17 = still processing — keep polling
      res.json({ status: 'PENDING', resultDesc: 'Waiting for M-Pesa response' });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Status check failed' });
    }
  },
);

// ─── GET /subscriptions/payments ──────────────────────────────────────────────
/**
 * FIX 7 — Missing endpoint
 * The frontend calls GET /subscriptions/payments in renderBillingHistory().
 * It expects: { payments: [...] } or { data: [...] }
 * Each item: { createdAt, planName, via, amountCents, currency, mpesaReceipt, stripeInvoiceId }
 *
 * Returns both M-Pesa payments (from MpesaTransaction) and Stripe invoices
 * (from StripeInvoice / Payment table if it exists), merged and sorted newest-first.
 */
/**
 * FIX 5 — GET /payments
 * Previous version queried prisma.mpesaTransaction which does not exist in
 * the schema. The actual table is Payment (mapped to "payments"), linked to
 * Subscription via subscriptionId.
 *
 * Payment schema: id, subscriptionId, stripePaymentIntentId, stripeInvoiceId,
 *                 amountCents, currency, status, createdAt
 * Plan name is obtained by joining through subscription → plan.
 */
router.get('/payments', requireAuth, billingLimiter, async (req, res) => {
  try {
    const userId = req.user!.id;

    const rawPayments = await prisma.payment.findMany({
      where: {
        status:       'succeeded',          // matches Stripe webhook values
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
      take: 100,
    });

    const payments = rawPayments.map(p => ({
      createdAt:       p.createdAt,
      planName:        p.subscription?.plan?.name ?? '—',
      // Detect payment method: M-Pesa payments won't have a stripeInvoiceId
      // (no separate M-Pesa table in this schema — M-Pesa payments are tracked
      //  via the auto-renew cron and logged differently).
      via:             p.stripeInvoiceId || p.stripePaymentIntentId
                         ? 'stripe'
                         : 'other',
      amountCents:     p.amountCents,
      currency:        p.currency ?? 'USD',
      mpesaReceipt:    null,                // M-Pesa receipts not in this model
      stripeInvoiceId: p.stripeInvoiceId ?? null,
    }));

    res.json({ success: true, payments });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to fetch payment history' });
  }
});

// ─── PUT /subscriptions/auto-renew ────────────────────────────────────────────
/**
 * FIX 6 — PUT /auto-renew
 * The previous implementation wrote to autoRenew and read provider fields that
 * do not exist on the Subscription model in schema.prisma. Prisma would throw
 * a runtime error on every call.
 *
 * For Stripe subscriptions, auto-renewal is controlled by cancel_at_period_end
 * via the /cancel and /reactivate endpoints — use those instead.
 *
 * If you need M-Pesa auto-renewal, add an autoRenew Boolean field and a
 * provider PaymentProvider enum field to the Subscription model in schema.prisma,
 * run prisma migrate, and restore the logic below.
 *
 * Until then, this route returns a clear explanation so the frontend can
 * show a helpful message rather than a silent 500.
 */
router.put(
  '/auto-renew',
  requireAuth,
  billingLimiter,
  [body('autoRenew').isBoolean().withMessage('autoRenew must be boolean')],
  async (req, res) => {
    if (!validate(req, res)) return;

    const { autoRenew } = req.body;

    // Stripe subscriptions: cancel = /cancel with immediately:false
    //                       reactivate = /reactivate
    // Return a response that makes sense to the frontend rather than crashing.
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
  async (req, res) => {
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

      // M-Pesa upgrades require a new STK push — redirect to /mpesa/initiate
      if ((currentSub as any).provider === 'MPESA') {
        res.status(400).json({
          error: 'M-Pesa upgrades require a new payment. Use /mpesa/initiate with the new plan.',
          code: 'MPESA_USE_INITIATE',
        });
        return;
      }

      const updated = await upgradeSubscription(
        user.id,
        planId,
        interval as BillingInterval,
        req.ip ?? undefined,
      );

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
  async (req, res) => {
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

      const updated = await scheduleDowngrade(
        user.id,
        planId,
        interval as BillingInterval,
        req.ip ?? undefined,
      );

      res.json({
        success: true,
        subscription: updated,
        message: 'Downgrade scheduled for next billing cycle',
      });
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
  async (req, res) => {
    if (!validate(req, res)) return;

    const { immediately = false, reason } = req.body;
    try {
      const updated = await cancelSubscription(
        req.user!.id,
        immediately,
        reason,
        req.ip ?? undefined,
      );
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
router.post('/reactivate', requireAuth, billingLimiter, async (req, res) => {
  try {
    const updated = await reactivateSubscription(req.user!.id, req.ip ?? undefined);
    res.json({
      success: true,
      subscription: updated,
      message: 'Subscription reactivated. Billing will resume as scheduled.',
    });
  } catch (err: any) {
    const status = err.message?.includes('not found') || err.message?.includes('no active') ? 404 : 500;
    res.status(status).json({ error: err.message ?? 'Reactivation failed' });
  }
});

// ─── GET /subscriptions/billing-portal ────────────────────────────────────────
router.get('/billing-portal', requireAuth, billingLimiter, async (req, res) => {
  try {
    const url = await getBillingPortalUrl(req.user!.id);
    res.json({ success: true, url });
  } catch (err: any) {
    // Distinguish M-Pesa (no Stripe customer) from other errors
    const msg = (err?.message ?? '').toLowerCase();
    if (msg.includes('mpesa') || msg.includes('no customer') || msg.includes('no billing')) {
      res.status(400).json({
        error: 'mpesa_no_billing_portal',
        message: 'Billing portal is only available for Stripe subscriptions.',
      });
      return;
    }
    res.status(500).json({ error: err.message ?? 'Failed to create billing portal session' });
  }
});

export default router;
