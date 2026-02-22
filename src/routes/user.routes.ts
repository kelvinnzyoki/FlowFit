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
// FIX 1: upsert uses { userId } as where — valid because userId is @unique in schema.
// FIX 2: removed manual updatedAt from update/create — Prisma handles it via @updatedAt.
// FIX 3: field names match the schema exactly (weight, height, age, fitnessGoal).
router.post('/metrics', async (req: AuthRequest, res: Response) => {
  try {
    const { weight, height, age, fitnessGoal } = req.body;

    const metrics = await prisma.userMetrics.upsert({
      where: { userId: req.user!.id },
      update: {
        ...(weight      !== undefined && { weight:      parseFloat(weight)  }),
        ...(height      !== undefined && { height:      parseFloat(height)  }),
        ...(age         !== undefined && { age:         parseInt(age)        }),
        ...(fitnessGoal !== undefined && { fitnessGoal                       }),
      },
      create: {
        userId:      req.user!.id,
        weight:      weight      != null ? parseFloat(weight)  : null,
        height:      height      != null ? parseFloat(height)  : null,
        age:         age         != null ? parseInt(age)        : null,
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
// FIX: findUnique uses { userId } — valid because userId is @unique in schema.
router.get('/metrics/history', async (req: AuthRequest, res: Response) => {
  try {
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
