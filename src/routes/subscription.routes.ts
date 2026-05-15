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
import { createHmac, timingSafeEqual } from 'crypto';
import { rateLimit }                  from 'express-rate-limit';
import { body, validationResult }     from 'express-validator';
import { requireAuth }                from '../middleware/auth.middleware.js';
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
import {
  verifyPaystackPayment,
  findPaystackSubscriptionByCustomer,
  generatePaystackManageLink,
  reconcilePaystackSubscriptionCodesForUser,
  reconcilePendingPaystackSubscriptions,
  getOrCreatePaystackCustomer,
} from '../services/paystack.service.js';
import { queryStkStatus, normalisePhone } from '../services/mpesa.service.js';
import { PLAN_HIERARCHY }             from '../types/subscription.types.js';
import type { PlanSlug }              from '../types/subscription.types.js';
import prisma                         from '../config/db.js';

const router = Router();

// FIX-7: Removed setInterval-based reconciliation cron.
// Vercel serverless functions are stateless — globalThis does not persist across
// invocations, and setInterval either never fires (cold start) or is garbage
// collected after the request completes. INCOMPLETE subscriptions that missed
// their webhook were silently never reconciled.
//
// Replacement: a POST /subscriptions/paystack/cron-reconcile endpoint secured with
// a shared CRON_SECRET header. Configure Vercel Cron (vercel.json) or an external
// scheduler (e.g. cron-job.org) to POST to this endpoint every 10 minutes.

// ISSUE-14: Warn loudly on startup if CRON_SECRET is missing — without it every
// POST /paystack/cron-reconcile returns 401 silently and reconciliation never runs.
if (!process.env.CRON_SECRET) {
  console.warn(
    '[subscription_routes] WARNING: CRON_SECRET env var is not set. ' +
    'POST /paystack/cron-reconcile will reject all requests (401). ' +
    'Set CRON_SECRET in Vercel → Settings → Environment Variables.',
  );
}

// ── Rate limiters ─────────────────────────────────────────────────────────────
const billingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many billing requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  // ISSUE-5-FIX: Key by user ID, not IP. Without this a user behind shared NAT
  // (corporate network, mobile carrier) gets blocked when another user on the
  // same IP hits the limit. Matches checkoutLimiter and trialLimiter behaviour.
  keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? 'anonymous',
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
  // ISSUE-7-FIX: Use only FRONTEND_URL. APP_URL is the API server domain — if
  // FRONTEND_URL is unset and APP_URL is used instead, Paystack redirects the
  // user to the API server after payment (which has no subscription.html), the
  // ?reference= param is lost, and the subscription stays INCOMPLETE forever.
  // getFrontendUrl() in subscription_service.ts already enforces this; match it here.
  const allowed = process.env.FRONTEND_URL || '';
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
        select: { slug: true, paystackPlanCodeMonthly: true, paystackPlanCodeYearly: true },
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
      console.error('[checkout]', err);
      const status = err.message?.includes('not found') ? 404 : 500;
      res.status(status).json({ error: status === 404 ? 'Plan not found' : 'Checkout failed. Please try again.' });
    }
  },
);

// ─── GET /subscriptions/paystack/verify/:reference ───────────────────────────
//
// Called by the frontend after Paystack redirects back to callbackUrl.
// Important: this endpoint verifies the payment, but it only returns normal
// success when subscription_code + email_token have been stored. If Paystack has
// not emitted subscription.create yet, it returns HTTP 202 so the frontend keeps
// showing a processing state instead of showing a false ACTIVE state.
router.get(
  '/paystack/verify/:reference',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  async (req: Request, res: Response) => {
    const { reference } = req.params;

    if (!reference || reference.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(reference)) {
      res.status(400).json({ success: false, error: 'Invalid reference format' });
      return;
    }

    try {
      const result = await verifyPaystackPayment(reference, req.user!.id);

      if (!result.success) {
        res.status(400).json({
          success: false,
          status: result.status,
          message: result.message ?? 'Payment could not be verified',
        });
        return;
      }

      if (result.status === 'pending_subscription_codes' || result.pending) {
        const reconciled = await reconcilePaystackSubscriptionCodesForUser(req.user!.id, reference);

        if (reconciled.activated > 0 && reconciled.subscription?.status === 'ACTIVE') {
          res.json({
            success: true,
            pending: false,
            status: 'success',
            subscription: reconciled.subscription,
            message: 'Payment verified. Paystack subscription codes were stored and subscription is now active.',
          });
          return;
        }

        res.status(202).json({
          success: true,
          pending: true,
          status: 'pending_subscription_codes',
          subscription: reconciled.subscription ?? result.subscription ?? null,
          reconcile: {
            checked: reconciled.checked,
            activated: reconciled.activated,
            stillPending: reconciled.stillPending,
            errors: reconciled.errors,
          },
          message:
            result.message ??
            'Payment verified. Waiting for Paystack to create the subscription codes.',
        });
        return;
      }

      res.json({
        success: true,
        pending: false,
        status: result.status,
        subscription: result.subscription,
        message: 'Payment verified. Subscription is now active.',
      });
    } catch (err: any) {
      console.error('[paystack verify]', err);
      res.status(500).json({ success: false, error: 'Payment verification failed. Please try again.' });
    }
  },
);

// ─── GET /subscriptions/paystack/fetch-codes ─────────────────────────────────
//
// Manual/poll fallback. It checks the latest INCOMPLETE or ACTIVE Paystack row,
// fetches Paystack's subscription object by customer, stores both codes, and
// activates the row only when both subscription_code and email_token are present.
router.get(
  '/paystack/fetch-codes',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 8 }),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    try {
      const reconciled = await reconcilePaystackSubscriptionCodesForUser(userId);
      if (reconciled.activated > 0 && reconciled.subscription?.status === 'ACTIVE') {
        res.json({
          success: true,
          pending: false,
          fetched: true,
          subscription: reconciled.subscription,
          message: reconciled.message,
        });
        return;
      }

      const sub = await prisma.subscription.findFirst({
        where: {
          userId,
          provider: 'PAYSTACK',
          status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD'] },
        },
        orderBy: { updatedAt: 'desc' },
        include: { plan: true },
      });

      if (!sub) {
        res.status(404).json({ success: false, error: 'No Paystack subscription row found' });
        return;
      }

      if (sub.paystackSubscriptionCode && sub.paystackEmailToken && sub.status === 'ACTIVE') {
        // ISSUE-1a: Never send paystackSubscriptionCode or paystackEmailToken to the client.
        // email_token is the second auth factor for disable/enable — anyone who intercepts
        // it can cancel or reactivate the subscription on Paystack directly.
        res.json({
          success: true,
          pending: false,
          fetched: false,
          codesStored: true,
          message: 'Subscription codes already stored.',
        });
        return;
      }

      const planCode = sub.interval === 'YEARLY'
        ? (sub.plan as any)?.paystackPlanCodeYearly
        : (sub.plan as any)?.paystackPlanCodeMonthly;

      if (!sub.paystackCustomerCode) {
        res.status(409).json({
          success: false,
          pending: true,
          error: 'Subscription has no paystackCustomerCode. Start checkout again.',
        });
        return;
      }

      const found = await findPaystackSubscriptionByCustomer(sub.paystackCustomerCode, planCode);

      if (!found?.subscription_code || !found?.email_token) {
        // ISSUE-1b: No credentials in this response — client uses codesStored flag only.
        res.status(202).json({
          success: true,
          pending: true,
          fetched: false,
          codesStored: false,
          message: 'Paystack subscription codes are not available yet. Wait for subscription.create webhook.',
        });
        return;
      }

      const now = new Date();
      const currentPeriodEnd = found.next_payment_date
        ? new Date(found.next_payment_date)
        : (() => {
            const d = new Date(now);
            if (sub.interval === 'YEARLY') d.setFullYear(d.getFullYear() + 1);
            else d.setMonth(d.getMonth() + 1);
            return d;
          })();

      // ISSUE-3-FIX: Guard against reactivating a terminal row. Both activateWithCodes
      // and activatePendingPaystackSubscriptionFromCodes have this guard; the direct
      // fetch-codes path must match. A race between the expiry cron and a user polling
      // fetch-codes could otherwise reactivate an INCOMPLETE_EXPIRED row.
      if (['CANCELLED', 'EXPIRED', 'INCOMPLETE_EXPIRED'].includes(sub.status)) {
        res.status(409).json({
          success: false,
          error: 'Subscription has expired and cannot be activated. Please start a new subscription.',
        });
        return;
      }

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          paystackSubscriptionCode: found.subscription_code,
          paystackEmailToken: found.email_token,
          currentPeriodStart: sub.currentPeriodStart ?? now,
          currentPeriodEnd,
          activatedAt: sub.activatedAt ?? now,
          cancelAtPeriodEnd: false,
          autoRenew: true,
        },
      });

      if (sub.paystackReference) {
        const existingPayment = await prisma.payment.findFirst({
          where: { paystackReference: sub.paystackReference },
        });

        if (!existingPayment) {
          await prisma.payment.create({
            data: {
              subscriptionId: sub.id,
              paystackReference: sub.paystackReference,
              // ISSUE-13: mpesaMonthlyKes/mpesaYearlyKes store the KES price used for both
              // M-Pesa and Paystack (same price). Multiply by 100 to convert to kobo
              // (Paystack's smallest unit). Math is correct; naming is shared by design.
              amountCents: sub.interval === 'YEARLY'
                ? Number((sub.plan as any)?.mpesaYearlyKes ?? 0) * 100
                : Number((sub.plan as any)?.mpesaMonthlyKes ?? 0) * 100,
              currency: 'KES',
              status: 'succeeded',
              paidAt: sub.currentPeriodStart ?? now,
              provider: 'PAYSTACK',
            },
          }).catch(async (err: any) => {
            const createdByRace = await prisma.payment.findFirst({ where: { paystackReference: sub.paystackReference } });
            if (!createdByRace) throw err;
          });
        }
      }

      // ISSUE-1c: Return the full subscription object instead of raw codes.
      // Never send paystackSubscriptionCode or paystackEmailToken to the client.
      const activatedSub = await getCurrentSubscription(userId);
      res.json({
        success: true,
        pending: false,
        fetched: true,
        codesStored: true,
        subscription: activatedSub,
        message: 'Subscription codes stored and subscription activated.',
      });
    } catch (err: any) {
      console.error('[paystack/fetch-codes]', err?.message ?? err);
      res.status(500).json({ success: false, error: 'Failed to fetch subscription codes' });
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
      const trialUserName = (user as { name?: string | null }).name ?? user.email.split('@')[0];

      const paystackCustomerCode = await getOrCreatePaystackCustomer(
        prisma,
        user.id,
        user.email,
        trialUserName,
      ).catch(() => null);

      const subscription = await prisma.subscription.create({
        data: {
          userId:             user.id,
          planId:             plan.id,
          status:             'TRIALING',
          provider:           'PAYSTACK',
          interval:           interval as BillingInterval,
          trialStartedAt:     now,
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd:   trialEndsAt,
          cancelAtPeriodEnd:  false,
          autoRenew:          true,
          ...(paystackCustomerCode ? { paystackCustomerCode } : {}),
        },
        include: { plan: true },
      });

      res.json({ success: true, subscription });
    } catch (err: any) {
      console.error('[trial]', err);
      res.status(500).json({ error: 'Could not start trial. Please try again.' });
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
        select: { slug: true, paystackPlanCodeMonthly: true, paystackPlanCodeYearly: true },
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

      const updated = await upgradeSubscription(user.id, planId, interval as BillingInterval, req.ip ?? undefined);
      res.json({ success: true, subscription: updated });
    } catch (err: any) {
      const message = err.message ?? 'Upgrade failed';
      if (message.startsWith('PAYSTACK_NEW_CHECKOUT_REQUIRED')) {
        res.status(400).json({
          success: false,
          code: 'PAYSTACK_NEW_CHECKOUT_REQUIRED',
          error: 'Paystack upgrades require a new checkout payment.',
          nextAction: 'START_CHECKOUT',
          planId,
          interval,
        });
        return;
      }
      console.error('[upgrade]', err);
      res.status(500).json({ success: false, error: 'Upgrade failed. Please try again.' });
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

      if (String(targetPlan.slug).toLowerCase() === 'free') {
        res.status(400).json({ error: 'Use the cancel button to move to the Free plan.' });
        return;
      }

      const updated = await scheduleDowngrade(user.id, planId, interval as BillingInterval, req.ip ?? undefined);
      res.json({
        success: true,
        subscription: updated,
        message: 'Downgrade scheduled. Your current plan will run until period end, then the lower plan will apply automatically.',
      });
    } catch (err: any) {
      console.error('[downgrade]', err);
      res.status(500).json({ error: 'Downgrade failed. Please try again.' });
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
      console.error('[cancel]', err);
      const status = err.message?.includes('not found') || err.message?.includes('no active') ? 404 : 500;
      res.status(status).json({ error: status === 404 ? 'No active subscription found' : 'Cancellation failed. Please try again.' });
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
    console.error('[reactivate]', err);
    const status = err.message?.includes('not found') || err.message?.includes('no active') ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'No inactive subscription found to reactivate' : 'Reactivation failed. Please try again.' });
  }
});

// ─── GET /subscriptions/billing-portal ───────────────────────────────────────
//
// Paystack supports a per-subscription management/update-card link. It requires
// paystackSubscriptionCode to be stored. If the code/token is missing, the API
// fails clearly instead of returning the local subscription page as if billing
// management worked.
router.get('/billing-portal', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const sub = await prisma.subscription.findFirst({
      where: {
        userId: req.user!.id,
        provider: 'PAYSTACK',
        status: { in: ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'] },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        paystackSubscriptionCode: true,
        paystackEmailToken: true,
      },
    });

    if (!sub) {
      res.status(404).json({ success: false, error: 'No active Paystack subscription found' });
      return;
    }

    if (!sub.paystackSubscriptionCode || !sub.paystackEmailToken) {
      res.status(409).json({
        success: false,
        pending: true,
        error: 'Billing management is not ready because Paystack subscription codes are missing.',
        action: 'retry_fetch_codes',
      });
      return;
    }

    const url = await generatePaystackManageLink(sub.paystackSubscriptionCode);
    res.json({ success: true, url });
  } catch (err: any) {
    console.error('[billing-portal]', err?.message ?? err);
    res.status(500).json({ success: false, error: 'Failed to open Paystack billing management. Please try again.' });
  }
});


// ─── POST /subscriptions/paystack/cron-reconcile ─────────────────────────────
// FIX-7: Replaces the removed setInterval cron. Call this endpoint from Vercel Cron
// (vercel.json) or an external scheduler every 10 minutes.
//
// vercel.json example:
// { "crons": [{ "path": "/api/subscriptions/paystack/cron-reconcile", "schedule": "*/10 * * * *" }] }
//
// Secured with a shared secret (CRON_SECRET env var) checked via the
// x-cron-secret header — Vercel sets this automatically when using Vercel Cron.
router.post('/paystack/cron-reconcile', async (req: Request, res: Response) => {
  const cronSecret  = process.env.CRON_SECRET ?? '';
  const providedRaw = req.headers['x-cron-secret'] ?? req.headers['authorization']?.replace('Bearer ', '');
  const provided    = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;

  const expectedBuffer = createHmac('sha256', 'ff_cron').update(cronSecret).digest();
  const providedBuffer = createHmac('sha256', 'ff_cron').update(provided ?? '').digest();

  if (
    !cronSecret ||
    !provided ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const result = await reconcilePendingPaystackSubscriptions(25);
    console.log('[cron-reconcile]', result.message);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[cron-reconcile] failed:', err?.message ?? err);
    res.status(500).json({ success: false, error: 'Reconciliation failed. Please try again.' });
  }
});

// ─── POST /subscriptions/paystack/reconcile-pending ──────────────────────────
// Admin/manual safety valve for recent Paystack payments whose subscription.create
// webhook arrived late or was temporarily blocked. This never activates without
// both subscription_code and email_token.
router.post('/paystack/reconcile-pending', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { role: true },
    });

    if (dbUser?.role !== 'ADMIN') {
      res.status(403).json({ success: false, error: 'Admin access required' });
      return;
    }

    const result = await reconcilePendingPaystackSubscriptions(25);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[paystack/reconcile-pending]', err?.message ?? err);
    res.status(500).json({ success: false, error: 'Paystack reconciliation failed. Please try again.' });
  }
});

export default router;
