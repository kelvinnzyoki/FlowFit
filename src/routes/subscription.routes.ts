import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/subscriptions/me ────────────────────────────────────────────
// Called by: SubscriptionAPI.getCurrentSubscription()
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const subscription = await prisma.subscription.findFirst({
      where:   { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });

    // Return a free-tier response if no subscription exists
    if (!subscription) {
      res.status(200).json({
        success: true,
        data: { plan: 'free', status: 'active', userId: req.user!.id },
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
// Stub: plug in Stripe or LemonSqueezy here when ready
router.post('/checkout', async (req: AuthRequest, res: Response) => {
  try {
    const { plan } = req.body;

    const validPlans = ['pro', 'elite'];
    if (!plan || !validPlans.includes(plan)) {
      res.status(400).json({ success: false, error: `Plan must be one of: ${validPlans.join(', ')}.` });
      return;
    }

    // TODO: Create a real Stripe checkout session and return the URL.
    // For now, return a placeholder so the frontend doesn't break.
    res.status(200).json({
      success: true,
      data: {
        checkoutUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?plan=${plan}`,
        plan,
        message: 'Payment integration coming soon.',
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
    const subscription = await prisma.subscription.findFirst({
      where: { userId: req.user!.id, status: 'active' },
    });

    if (!subscription) {
      res.status(404).json({ success: false, error: 'No active subscription found.' });
      return;
    }

    const updated = await prisma.subscription.update({
      where: { id: subscription.id },
      data:  { status: 'cancelled', cancelledAt: new Date() },
    });

    res.status(200).json({ success: true, data: updated, message: 'Subscription cancelled.' });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel subscription.' });
  }
});

export default router;
