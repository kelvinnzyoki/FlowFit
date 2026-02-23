import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/subscriptions/me ────────────────────────────────────────────
// Called by: SubscriptionAPI.getCurrentSubscription()
// Schema: Subscription is one-to-one (userId @unique), includes Payment history
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const subscription = await prisma.subscription.findUnique({
      where:   { userId: req.user!.id },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 5 } },
    });

    // Return free-tier shape if no subscription record exists yet
    if (!subscription) {
      res.status(200).json({
        success: true,
        data: {
          plan:   'FREE',
          status: 'ACTIVE',
          userId: req.user!.id,
        },
      });
      return;
    }

    res.status(200).json({ success: true, data: subscription });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch subscription.' });
  }
});

// ─── POST /api/v1/subscriptions/checkout ─────────────────────────────────────
// Called by: SubscriptionAPI.createCheckoutSession(plan)
// Stub — plug in Stripe or M-Pesa here. Returns a checkout URL for the frontend.
router.post('/checkout', async (req: AuthRequest, res: Response) => {
  try {
    const { plan } = req.body;

    const validPlans = ['PRO', 'PREMIUM'];
    if (!plan || !validPlans.includes(plan.toUpperCase())) {
      res.status(400).json({
        success: false,
        error: `Plan must be one of: ${validPlans.join(', ')}.`,
      });
      return;
    }

    // TODO: Create a real Stripe checkout session here
    // const session = await stripe.checkout.sessions.create({ ... });
    // Return session.url to the frontend

    res.status(200).json({
      success: true,
      data: {
        checkoutUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?plan=${plan.toLowerCase()}`,
        plan:        plan.toUpperCase(),
        message:     'Payment integration coming soon.',
      },
    });
  } catch (error) {
    console.error('Create checkout session error:', error);
    res.status(500).json({ success: false, error: 'Failed to create checkout session.' });
  }
});

// ─── POST /api/v1/subscriptions/cancel ───────────────────────────────────────
// Called by: SubscriptionAPI.cancelSubscription()
router.post('/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId: req.user!.id },
    });

    if (!subscription || subscription.status === 'CANCELLED') {
      res.status(404).json({ success: false, error: 'No active subscription found.' });
      return;
    }

    const updated = await prisma.subscription.update({
      where: { userId: req.user!.id },
      data:  {
        status:            'CANCELLED',
        cancelAtPeriodEnd: true,
      },
    });

    res.status(200).json({
      success: true,
      data:    updated,
      message: 'Subscription cancelled. You will retain access until the end of your billing period.',
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel subscription.' });
  }
});

export default router;
