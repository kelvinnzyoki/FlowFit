import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { body, param, validationResult } from 'express-validator';
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
import {
  initiateStkPush,
  queryStkStatus,
  normalizePhone,
  centsToKes,
} from '../services/mpesa.service.js';



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

const mpesaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,
  message: { error: 'Too many M-Pesa requests. Please try again later.' },
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

      // Downgrading to free has no Stripe price — treat it as cancel at period end.
      // cancelSubscription(immediately=false) sets cancel_at_period_end=true on Stripe,
      // keeping access until the billing period ends then reverting to free.
      const isFreeTarget = targetPlan.slug === 'free';
      if (isFreeTarget) {
        const updated = await cancelSubscription(
          user.id, false, 'downgrade_to_free', req.ip ?? undefined,
        );
        res.json({ subscription: updated, message: 'Downgrade to free scheduled — access continues until billing period ends' });
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


// ─── GET /subscriptions/checkout-success ─────────────────────────────────────
// Stripe redirects here after successful payment.
// We do a server-side 302 to the frontend HTML page.
// FRONTEND_URL env var = where your HTML files live (can equal APP_URL if same domain).
// If FRONTEND_URL is not set, falls back to APP_URL.
router.get('/checkout-success', (req: Request, res: Response) => {
  const frontendUrl = (process.env.FRONTEND_URL || process.env.APP_URL || '').replace(/\/$/, '');
  const sessionId   = req.query.session_id as string ?? '';
  res.redirect(302, `${frontendUrl}/subscription.html?success=1&session_id=${sessionId}`);
});

// ─── GET /subscriptions/checkout-cancel ──────────────────────────────────────
// Stripe redirects here when user clicks "Back" on the Stripe checkout page.
router.get('/checkout-cancel', (_req: Request, res: Response) => {
  const frontendUrl = (process.env.FRONTEND_URL || process.env.APP_URL || '').replace(/\/$/, '');
  res.redirect(302, `${frontendUrl}/subscription.html?cancelled=1`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-PESA (SAFARICOM DARAJA) ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
// Required ENV vars:
//   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY
//   MPESA_ENV (sandbox|production), MPESA_EXCHANGE_RATE (KES per USD, default 130)
//   APP_URL (your deployed URL, used to build callback URL)
// ─────────────────────────────────────────────────────────────────────────────

// ─── POST /subscriptions/mpesa/initiate ──────────────────────────────────────
// Sends an STK push to the user's Safaricom phone.
// Returns { checkoutRequestId } which the frontend polls for status.
router.post(
  '/mpesa/initiate',
  requireAuth,
  mpesaLimiter,
  [
    validatePlanId,
    validateInterval,
    body('phone').isString().notEmpty().withMessage('phone is required'),
  ],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;

    const { planId, interval, phone: rawPhone } = req.body as {
      planId: string;
      interval: BillingInterval;
      phone: string;
    };
    const user = req.user!;

    // 1. Resolve plan
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

    // 2. Normalise phone
    let phone: string;
    try {
      phone = normalizePhone(rawPhone);
    } catch (e: any) {
      res.status(400).json({ error: e.message }); return;
    }

    // 3. Calculate KES amount from plan price + exchange rate
    const priceCents = interval === 'YEARLY' ? plan.yearlyPriceCents : plan.monthlyPriceCents;
    if (!priceCents || priceCents === 0) {
      res.status(400).json({ error: 'Cannot process M-Pesa payment for a free plan' }); return;
    }
    const amountKes = centsToKes(priceCents);

    // 4. Build callback URL — Safaricom will POST result here
    const appUrl      = (process.env.APP_URL ?? '').replace(/\/$/, '');
    const callbackUrl = `${appUrl}/api/v1/subscriptions/mpesa/callback`;

    // 5. Initiate STK push
    try {
      const stkResult = await initiateStkPush(
        phone,
        amountKes,
        `FLOWFIT-${plan.slug.toUpperCase()}`,
        `FLOWFIT ${plan.name} ${interval}`,
        callbackUrl,
      );

      // 6. Store pending transaction in DB so callback can match it
      await prisma.mpesaTransaction.create({
        data: {
          userId:             user.id,
          planId:             plan.id,
          interval,
          phone,
          amountKes,
          checkoutRequestId:  stkResult.CheckoutRequestID,
          merchantRequestId:  stkResult.MerchantRequestID,
          status:             'PENDING',
        },
      });

      res.json({ checkoutRequestId: stkResult.CheckoutRequestID, message: 'STK push sent' });
    } catch (err: any) {
      console.error('[M-Pesa initiate]', err);
      res.status(500).json({ error: err.message ?? 'M-Pesa STK push failed' });
    }
  },
);

// ─── POST /subscriptions/mpesa/callback ──────────────────────────────────────
// Safaricom posts the STK push result here (no auth — validated by payload).
// Always returns 200 so Safaricom stops retrying.
router.post('/mpesa/callback', async (req: Request, res: Response) => {
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) { res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); return; }

    const checkoutRequestId = body.CheckoutRequestID as string;
    const resultCode        = String(body.ResultCode);

    const txn = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId } });
    if (!txn) {
      // Unknown transaction — ack anyway so Safaricom stops retrying
      res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); return;
    }

    if (resultCode === '0') {
      // Payment successful — extract M-Pesa receipt number
      const items: any[] = body.CallbackMetadata?.Item ?? [];
      const receipt = items.find((i: any) => i.Name === 'MpesaReceiptNumber')?.Value as string | undefined;

      // Activate subscription in a transaction
      await prisma.$transaction(async (tx) => {
        // Mark M-Pesa transaction as completed
        await tx.mpesaTransaction.update({
          where: { checkoutRequestId },
          data: { status: 'COMPLETED', mpesaReceiptNumber: receipt ?? null },
        });

        // Find or create subscription — look for existing INCOMPLETE or create fresh
        const existing = await tx.subscription.findFirst({
          where: { userId: txn.userId, planId: txn.planId, status: 'INCOMPLETE' },
        });

        const now     = new Date();
        const monthly = txn.interval === 'MONTHLY';
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + (monthly ? 1 : 12));

        const subData = {
          status:             'ACTIVE'   as const,
          interval:           txn.interval,
          currentPeriodStart: now,
          currentPeriodEnd:   periodEnd,
          activatedAt:        now,
        };

        let subId: string;
        if (existing) {
          await tx.subscription.update({ where: { id: existing.id }, data: subData });
          subId = existing.id;
        } else {
          // Deactivate any previous active sub first
          await tx.subscription.updateMany({
            where: { userId: txn.userId, status: { in: ['ACTIVE', 'TRIALING'] } },
            data: { status: 'CANCELLED', cancelledAt: now },
          });
          const created = await tx.subscription.create({
            data: { userId: txn.userId, planId: txn.planId, ...subData },
          });
          subId = created.id;
        }

        // Record payment
        await tx.payment.create({
          data: {
            subscriptionId: subId,
            amountCents:    Math.round(txn.amountKes / parseFloat(process.env.MPESA_EXCHANGE_RATE ?? '130') * 100),
            currency:       'KES',
            status:         'succeeded',
          },
        });

        await tx.subscriptionLog.create({
          data: {
            subscriptionId: subId,
            event:          'ACTIVATED',
            previousStatus: existing?.status ?? 'INCOMPLETE',
            newStatus:      'ACTIVE',
            metadata: { via: 'mpesa', receipt, checkoutRequestId },
          },
        });
      });

    } else {
      // Payment failed or cancelled by user
      await prisma.mpesaTransaction.update({
        where: { checkoutRequestId },
        data: { status: 'FAILED', resultCode, resultDesc: body.ResultDesc ?? '' },
      });
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('[M-Pesa callback]', err);
    // Always 200 — Safaricom retries on non-200
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// ─── GET /subscriptions/mpesa/status/:checkoutRequestId ──────────────────────
// Frontend polls this after STK push to check if payment completed.
router.get(
  '/mpesa/status/:checkoutRequestId',
  requireAuth,
  [param('checkoutRequestId').isString().notEmpty()],
  async (req: Request, res: Response) => {
    const { checkoutRequestId } = req.params;

    const txn = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
    });

    if (!txn) { res.status(404).json({ error: 'Transaction not found' }); return; }

    // Security: only the transaction owner can poll its status
    if (txn.userId !== req.user!.id) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }

    if (txn.status === 'COMPLETED') {
      res.json({ status: 'COMPLETED', message: 'Payment successful' }); return;
    }
    if (txn.status === 'FAILED') {
      res.json({ status: 'FAILED', message: txn.resultDesc || 'Payment was not completed' }); return;
    }

    // Still PENDING — optionally query Safaricom directly to avoid waiting for callback
    try {
      const queryResult = await queryStkStatus(checkoutRequestId);
      if (queryResult.ResultCode === '0') {
        // Safaricom says paid — callback may not have arrived yet; optimistically return COMPLETED
        res.json({ status: 'COMPLETED', message: 'Payment confirmed by Safaricom' }); return;
      } else if (queryResult.ResultCode && queryResult.ResultCode !== '1032') {
        // 1032 = request cancelled by user; any other non-zero code is a real failure
        await prisma.mpesaTransaction.update({
          where: { checkoutRequestId },
          data: { status: 'FAILED', resultCode: queryResult.ResultCode, resultDesc: queryResult.ResultDesc },
        });
        res.json({ status: 'FAILED', message: queryResult.ResultDesc || 'Payment failed' }); return;
      }
    } catch {
      // Safaricom query failed — fall through to PENDING
    }

    res.json({ status: 'PENDING', message: 'Awaiting payment confirmation' });
  },
);

export default router;
