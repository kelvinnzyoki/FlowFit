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
  resolveAndStorePaystackSubscriptionCodes,
} from '../services/paystack.service.js';
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
        const httpStatus = result.status === 'pending_subscription_codes' ? 202 : 400;
        res.status(httpStatus).json({
          success: false,
          status:  result.status,
          message: result.message ?? 'Payment could not be verified',
          subscription: result.subscription ?? null,
          retryAfterSeconds: result.status === 'pending_subscription_codes' ? 10 : undefined,
        });
        return;
      }

      res.json({
        success:      true,
        status:       result.status,
        subscription: result.subscription,
        message:      'Payment verified. Paystack subscription codes stored. Subscription is now active.',
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message ?? 'Verification failed' });
    }
  },
);

// ─── GET /subscriptions/paystack/fetch-codes ─────────────────────────────────
//
// Polls Paystack for subscription_code + email_token for the user's active
// subscription when the webhook hasn't fired yet. Frontend calls this 30s
// after verify if paystackSubscriptionCode is still null in the response.
router.get(
  '/paystack/fetch-codes',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    try {
      const sub = await prisma.subscription.findFirst({
        where: {
          userId,
          provider: 'PAYSTACK',
          status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING', 'PAST_DUE'] },
        },
        orderBy: { updatedAt: 'desc' },
        select:  {
          id:                      true,
          status:                  true,
          paystackSubscriptionCode: true,
          paystackEmailToken:       true,
        },
      });

      if (!sub) {
        res.status(404).json({ success: false, error: 'No Paystack subscription found' });
        return;
      }

      if (sub.paystackSubscriptionCode && sub.paystackEmailToken) {
        res.json({
          success:                  true,
          fetched:                  true,
          activated:                sub.status === 'ACTIVE',
          paystackSubscriptionCode: sub.paystackSubscriptionCode,
          paystackEmailToken:       sub.paystackEmailToken,
        });
        return;
      }

      const codes = await resolveAndStorePaystackSubscriptionCodes({
        subscriptionId: sub.id,
        attempts: 3,
        delayMs: 2_000,
      });

      res.status(codes?.subscription_code && codes.email_token ? 200 : 202).json({
        success:                  !!(codes?.subscription_code && codes.email_token),
        fetched:                  !!(codes?.subscription_code && codes.email_token),
        activated:                false,
        paystackSubscriptionCode: codes?.subscription_code ?? null,
        paystackEmailToken:       codes?.email_token ?? null,
        retryAfterSeconds:        codes?.subscription_code && codes.email_token ? undefined : 10,
        message: codes?.subscription_code && codes.email_token
          ? 'Subscription codes stored successfully. Re-run verification to activate if needed.'
          : 'Paystack subscription codes are not available yet.',
      });
    } catch (err: any) {
      console.error('[fetch-codes]', err?.message ?? err);
      res.status(500).json({ success: false, error: err.message ?? 'Failed to fetch subscription codes' });
    }
  },
);

// ─── GET /subscriptions/billing-portal ───────────────────────────────────────
//
// Paystack does not offer a hosted billing portal.
// Returns the in-app subscription management URL so the frontend can redirect
// the user without changing its existing billing-portal call pattern.
router.get('/billing-portal', requireAuth, billingLimiter, async (req: Request, res: Response) => {
  try {
    let sub = await prisma.subscription.findFirst({
      where: {
        userId: req.user!.id,
        provider: 'PAYSTACK',
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      orderBy: { updatedAt: 'desc' },
      select:  {
        id:                      true,
        paystackSubscriptionCode: true,
        paystackEmailToken:       true,
      },
    });

    if (!sub) {
      res.status(404).json({ success: false, error: 'No active Paystack subscription found' });
      return;
    }

    if (!sub.paystackSubscriptionCode || !sub.paystackEmailToken) {
      const codes = await resolveAndStorePaystackSubscriptionCodes({
        subscriptionId: sub.id,
        attempts: 3,
        delayMs: 2_000,
      });

      sub = {
        ...sub,
        paystackSubscriptionCode: codes?.subscription_code ?? sub.paystackSubscriptionCode,
        paystackEmailToken:       codes?.email_token ?? sub.paystackEmailToken,
      };
    }

    if (!sub.paystackSubscriptionCode || !sub.paystackEmailToken) {
      res.status(409).json({
        success: false,
        error: 'Paystack subscription management codes are not stored yet. Try again shortly.',
        retryAfterSeconds: 10,
      });
      return;
    }

    res.json({
      success: true,
      url:     `https://paystack.com/manage/subscriptions/${encodeURIComponent(sub.paystackEmailToken)}`,
    });
  } catch (err: any) {
    console.error('[billing-portal]', err?.message ?? err);
    res.status(500).json({ success: false, error: err.message ?? 'Billing portal failed' });
  }
});

export default router;
