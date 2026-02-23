// Path: src/routes/progress.routes.ts
import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── POST /api/v1/progress ───────────────────────────────────────────────────
// Called by: ProgressAPI.logWorkout(workoutData)
// Schema fields on WorkoutLog: exerciseId, duration, date, sets, reps,
//   caloriesBurned, heartRate, difficulty, notes, completed
// NOT: workoutId, completedAt — those don't exist in your schema
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      exerciseId,
      duration,
      sets,
      reps,
      caloriesBurned,
      heartRate,
      difficulty,
      notes,
    } = req.body;

    if (!exerciseId || !duration) {
      res.status(400).json({ success: false, error: 'exerciseId and duration are required.' });
      return;
    }

    const log = await prisma.workoutLog.create({
      data: {
        userId,
        exerciseId,
        duration:       parseInt(duration),
        sets:           sets           ? parseInt(sets)             : null,
        reps:           reps           ? parseInt(reps)             : null,
        caloriesBurned: caloriesBurned ? parseFloat(caloriesBurned) : null,
        heartRate:      heartRate      ? parseInt(heartRate)        : null,
        difficulty:     difficulty     ?? null,
        notes:          notes          ?? null,
        // `date` defaults to now() per schema; `completed` defaults to true
      },
      include: { exercise: true }, // relation name is `exercise` per schema
    });

    // Update the Streak model after every logged workout
    await updateStreak(userId);

    res.status(201).json({ success: true, data: log });
  } catch (error) {
    console.error('Log workout error:', error);
    res.status(500).json({ success: false, error: 'Failed to log workout.' });
  }
});

// ─── GET /api/v1/progress/me ─────────────────────────────────────────────────
// Called by: ProgressAPI.getUserProgress()
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const logs = await prisma.workoutLog.findMany({
      where:   { userId: req.user!.id },
      include: { exercise: true },   // `exercise` not `workout`
      orderBy: { date: 'desc' },     // `date` not `completedAt`
      take:    50,
    });

    res.status(200).json({ success: true, data: logs });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch progress.' });
  }
});

// ─── GET /api/v1/progress/stats ──────────────────────────────────────────────
// Called by: ProgressAPI.getStats(period) — ?period=7d|30d|90d
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const period = (req.query.period as string) || '30d';
    const days   = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since  = new Date();
    since.setDate(since.getDate() - days);

    const logs = await prisma.workoutLog.findMany({
      where: {
        userId,
        date: { gte: since },        // `date` is the timestamp field in your schema
      },
      include: {
        exercise: {                   // `exercise` relation, not `workout`
          select: { name: true, category: true, caloriesPerMin: true },
        },
      },
    });

    const totalWorkouts = logs.length;
    const totalDuration = logs.reduce((s, l) => s + l.duration, 0);
    const totalCalories = logs.reduce((s, l) => s + (l.caloriesBurned ?? 0), 0);
    const avgDuration   = totalWorkouts ? Math.round(totalDuration / totalWorkouts) : 0;

    // Group by date for weekly chart
    const byDate: Record<string, number> = {};
    logs.forEach((l) => {
      const d = l.date.toISOString().split('T')[0]; // `date` field not `completedAt`
      byDate[d] = (byDate[d] || 0) + 1;
    });

    // Category breakdown
    const byCategory: Record<string, number> = {};
    logs.forEach((l) => {
      const cat = l.exercise.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    res.status(200).json({
      success: true,
      data: { period, totalWorkouts, totalDuration, totalCalories, avgDuration, byDate, byCategory },
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats.' });
  }
});

// ─── GET /api/v1/progress/history ────────────────────────────────────────────
// Called by: ProgressAPI.getWorkoutHistory(limit)
router.get('/history', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '20'), 100);

    const logs = await prisma.workoutLog.findMany({
      where:   { userId: req.user!.id },
      include: { exercise: true },   // `exercise` not `workout`
      orderBy: { date: 'desc' },     // `date` not `completedAt`
      take:    limit,
    });

    res.status(200).json({ success: true, data: logs });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch workout history.' });
  }
});

// ─── GET /api/v1/progress/streaks ────────────────────────────────────────────
// Called by: ProgressAPI.getStreaks()
// Reads directly from the dedicated Streak model in your schema
router.get('/streaks', async (req: AuthRequest, res: Response) => {
  try {
    const streak = await prisma.streak.findUnique({
      where: { userId: req.user!.id },
    });

    res.status(200).json({
      success: true,
      data: streak ?? { currentStreak: 0, longestStreak: 0, lastWorkoutDate: null },
    });
  } catch (error) {
    console.error('Get streaks error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch streak.' });
  }
});

// ─── GET /api/v1/progress/achievements ───────────────────────────────────────
// Called by: ProgressAPI.getAchievements()
router.get('/achievements', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const [allAchievements, userAchievements] = await Promise.all([
      prisma.achievement.findMany({ orderBy: { points: 'asc' } }),
      prisma.userAchievement.findMany({
        where:  { userId },
        select: { achievementId: true, unlockedAt: true },
      }),
    ]);

    const unlockedMap = new Map(userAchievements.map((ua) => [ua.achievementId, ua.unlockedAt]));

    const data = allAchievements.map((a) => ({
      ...a,
      unlocked:   unlockedMap.has(a.id),
      unlockedAt: unlockedMap.get(a.id) ?? null,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch achievements.' });
  }
});

// ─── Helper: update Streak model after each workout log ─────────────────────
async function updateStreak(userId: string) {
  try {
    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const existing = await prisma.streak.findUnique({ where: { userId } });

    if (!existing) {
      await prisma.streak.create({
        data: { userId, currentStreak: 1, longestStreak: 1, lastWorkoutDate: today },
      });
      return;
    }

    const last = existing.lastWorkoutDate ? new Date(existing.lastWorkoutDate) : null;
    if (last) last.setHours(0, 0, 0, 0);

    // Already logged today — no update needed
    if (last && last.getTime() === today.getTime()) return;

    const isConsecutive = last && last.getTime() === yesterday.getTime();
    const newCurrent    = isConsecutive ? existing.currentStreak + 1 : 1;
    const newLongest    = Math.max(existing.longestStreak, newCurrent);

    await prisma.streak.update({
      where: { userId },
      data:  { currentStreak: newCurrent, longestStreak: newLongest, lastWorkoutDate: today },
    });
  } catch (err) {
    // Non-fatal — streak failure should never block workout logging
    console.error('Streak update failed:', err);
  }
}

export default router;
