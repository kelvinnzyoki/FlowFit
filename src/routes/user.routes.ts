import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/users/me ─────────────────────────────────────────────────────
// Called by: UserAPI.getProfile()
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: { id: true, name: true, email: true, createdAt: true, metrics: true },
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    res.status(200).json({ success: true, data: user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch profile.' });
  }
});

// ─── PUT /api/v1/users/me ─────────────────────────────────────────────────────
// Called by: UserAPI.updateProfile(profileData)
router.put('/me', async (req: AuthRequest, res: Response) => {
  try {
    const { name, email } = req.body;

    // If changing email, ensure it is not already in use
    if (email && email !== req.user!.email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        res.status(409).json({ success: false, error: 'Email is already in use by another account.' });
        return;
      }
    }

    const updated = await prisma.user.update({
      where:  { id: req.user!.id },
      data:   { ...(name && { name }), ...(email && { email }) },
      select: { id: true, name: true, email: true, createdAt: true },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to update profile.' });
  }
});

// ─── POST /api/v1/users/metrics ──────────────────────────────────────────────
// Called by: UserAPI.updateMetrics(metrics)
// e.g. { weight, height, age, fitnessGoal }
router.post('/metrics', async (req: AuthRequest, res: Response) => {
  try {
    const { weight, height, age, fitnessGoal } = req.body;

    const metrics = await prisma.userMetrics.upsert({
      where:  { userId: req.user!.id },
      update: {
        ...(weight      !== undefined && { weight: parseFloat(weight) }),
        ...(height      !== undefined && { height: parseFloat(height) }),
        ...(age         !== undefined && { age: parseInt(age) }),
        ...(fitnessGoal !== undefined && { fitnessGoal }),
        updatedAt: new Date(),
      },
      create: {
        userId:      req.user!.id,
        weight:      weight      ? parseFloat(weight)  : null,
        height:      height      ? parseFloat(height)  : null,
        age:         age         ? parseInt(age)        : null,
        fitnessGoal: fitnessGoal ?? null,
      },
    });

    res.status(200).json({ success: true, data: metrics });
  } catch (error) {
    console.error('Update metrics error:', error);
    res.status(500).json({ success: false, error: 'Failed to update metrics.' });
  }
});

// ─── GET /api/v1/users/metrics/history ───────────────────────────────────────
// Called by: UserAPI.getMetricsHistory()
router.get('/metrics/history', async (req: AuthRequest, res: Response) => {
  try {
    // Return current metrics. For a full audit history you can add a MetricsHistory model to Prisma.
    const metrics = await prisma.userMetrics.findUnique({
      where: { userId: req.user!.id },
    });

    res.status(200).json({ success: true, data: metrics ?? {} });
  } catch (error) {
    console.error('Get metrics history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics.' });
  }
});

export default router;
