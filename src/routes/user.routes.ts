import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/users/me ─────────────────────────────────────────────────────
// Called by: UserAPI.getProfile()
// Returns user + their Profile (one-to-one) in one response
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: {
        id:              true,
        name:            true,
        email:           true,
        role:            true,
        isEmailVerified: true,
        lastLogin:       true,
        createdAt:       true,
        profile:         true,          // one-to-one Profile relation
      },
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
// Allows updating the User row (name/email) and/or the Profile row simultaneously
router.put('/me', async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, email,
      // Profile fields from the Profile model
      firstName, lastName, dateOfBirth, gender,
      height, weight, targetWeight,
      fitnessGoal, fitnessLevel, timezone, avatarUrl, bio,
    } = req.body;

    if (email && email !== req.user!.email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        res.status(409).json({ success: false, error: 'Email is already in use by another account.' });
        return;
      }
    }

    // Update user + profile in a single transaction
    const [updatedUser] = await prisma.$transaction([
      prisma.user.update({
        where:  { id: req.user!.id },
        data:   { ...(name && { name }), ...(email && { email }) },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      }),
      prisma.profile.upsert({
        where:  { userId: req.user!.id },
        update: {
          ...(firstName    !== undefined && { firstName }),
          ...(lastName     !== undefined && { lastName }),
          ...(dateOfBirth  !== undefined && { dateOfBirth: new Date(dateOfBirth) }),
          ...(gender       !== undefined && { gender }),
          ...(height       !== undefined && { height:       parseFloat(height) }),
          ...(weight       !== undefined && { weight:       parseFloat(weight) }),
          ...(targetWeight !== undefined && { targetWeight: parseFloat(targetWeight) }),
          ...(fitnessGoal  !== undefined && { fitnessGoal }),
          ...(fitnessLevel !== undefined && { fitnessLevel }),
          ...(timezone     !== undefined && { timezone }),
          ...(avatarUrl    !== undefined && { avatarUrl }),
          ...(bio          !== undefined && { bio }),
        },
        create: {
          userId: req.user!.id,
          firstName:    firstName    ?? null,
          lastName:     lastName     ?? null,
          dateOfBirth:  dateOfBirth  ? new Date(dateOfBirth) : null,
          gender:       gender       ?? null,
          height:       height       ? parseFloat(height)       : null,
          weight:       weight       ? parseFloat(weight)       : null,
          targetWeight: targetWeight ? parseFloat(targetWeight) : null,
          fitnessGoal:  fitnessGoal  ?? null,
          fitnessLevel: fitnessLevel ?? null,
          timezone:     timezone     ?? null,
          avatarUrl:    avatarUrl    ?? null,
          bio:          bio          ?? null,
        },
      }),
    ]);

    // Return updated user with profile attached
    const result = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: { id: true, name: true, email: true, role: true, createdAt: true, profile: true },
    });

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to update profile.' });
  }
});

// ─── POST /api/v1/users/metrics ──────────────────────────────────────────────
// Called by: UserAPI.updateMetrics(metrics)
// Schema: UserMetrics is an ARRAY model (one user → many metric snapshots over time)
// Each call adds a new snapshot row — this is intentional for tracking history.
router.post('/metrics', async (req: AuthRequest, res: Response) => {
  try {
    const { weight, bodyFat, muscleMass, bmi, restingHeartRate, notes } = req.body;

    const metrics = await prisma.userMetrics.create({
      data: {
        userId:           req.user!.id,
        weight:           weight           ? parseFloat(weight)           : null,
        bodyFat:          bodyFat          ? parseFloat(bodyFat)          : null,
        muscleMass:       muscleMass       ? parseFloat(muscleMass)       : null,
        bmi:              bmi              ? parseFloat(bmi)              : null,
        restingHeartRate: restingHeartRate ? parseInt(restingHeartRate)   : null,
        notes:            notes            ?? null,
      },
    });

    res.status(201).json({ success: true, data: metrics });
  } catch (error) {
    console.error('Update metrics error:', error);
    res.status(500).json({ success: false, error: 'Failed to save metrics.' });
  }
});

// ─── GET /api/v1/users/metrics/history ───────────────────────────────────────
// Called by: UserAPI.getMetricsHistory()
// Returns all metric snapshots ordered newest-first — perfect for charts
router.get('/metrics/history', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '30'), 100);

    const metrics = await prisma.userMetrics.findMany({
      where:   { userId: req.user!.id },
      orderBy: { date: 'desc' },
      take:    limit,
    });

    res.status(200).json({ success: true, data: metrics });
  } catch (error) {
    console.error('Get metrics history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics history.' });
  }
});

export default router;
