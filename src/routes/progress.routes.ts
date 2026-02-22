import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── POST /api/v1/progress ───────────────────────────────────────────────────
// Called by: ProgressAPI.logWorkout(workoutData)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { workoutId, duration, caloriesBurned, notes, completedAt } = req.body;

    if (!workoutId || !duration) {
      res.status(400).json({ success: false, error: 'workoutId and duration are required.' });
      return;
    }

    const log = await prisma.workoutLog.create({
      data: {
        userId,
        workoutId,
        duration:       parseInt(duration),
        caloriesBurned: caloriesBurned ? parseInt(caloriesBurned) : null,
        notes:          notes ?? null,
        completedAt:    completedAt ? new Date(completedAt) : new Date(),
      },
      include: { workout: true },
    });

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
      include: { workout: true },
      orderBy: { completedAt: 'desc' },
      take:    50,
    });

    res.status(200).json({ success: true, data: logs });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch progress.' });
  }
});

// ─── GET /api/v1/progress/stats ──────────────────────────────────────────────
// Called by: ProgressAPI.getStats(period) — period: '7d' | '30d' | '90d'
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const period = (req.query.period as string) || '30d';

    const days  = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const logs = await prisma.workoutLog.findMany({
      where: { userId, completedAt: { gte: since } },
      include: { workout: true },
    });

    const totalWorkouts  = logs.length;
    const totalDuration  = logs.reduce((sum, l) => sum + l.duration, 0);
    const totalCalories  = logs.reduce((sum, l) => sum + (l.caloriesBurned ?? 0), 0);
    const avgDuration    = totalWorkouts ? Math.round(totalDuration / totalWorkouts) : 0;

    // Group by date for charting
    const byDate: Record<string, number> = {};
    logs.forEach((log) => {
      const date = log.completedAt.toISOString().split('T')[0];
      byDate[date] = (byDate[date] || 0) + 1;
    });

    res.status(200).json({
      success: true,
      data: {
        period,
        totalWorkouts,
        totalDuration,
        totalCalories,
        avgDuration,
        byDate,
      },
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
      include: { workout: true },
      orderBy: { completedAt: 'desc' },
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
router.get('/streaks', async (req: AuthRequest, res: Response) => {
  try {
    const logs = await prisma.workoutLog.findMany({
      where:    { userId: req.user!.id },
      select:   { completedAt: true },
      orderBy:  { completedAt: 'desc' },
    });

    // Build unique workout days (YYYY-MM-DD)
    const days = [...new Set(logs.map((l) => l.completedAt.toISOString().split('T')[0]))].sort().reverse();

    let currentStreak = 0;
    let longestStreak = 0;
    let streak        = 0;

    for (let i = 0; i < days.length; i++) {
      if (i === 0) {
        streak = 1;
      } else {
        const prev = new Date(days[i - 1]);
        const curr = new Date(days[i]);
        const diff = (prev.getTime() - curr.getTime()) / (1000 * 60 * 60 * 24);
        streak = diff === 1 ? streak + 1 : 1;
      }
      longestStreak  = Math.max(longestStreak, streak);
      if (i === 0) currentStreak = streak;
    }

    res.status(200).json({
      success: true,
      data: { currentStreak, longestStreak, totalActiveDays: days.length },
    });
  } catch (error) {
    console.error('Get streaks error:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate streaks.' });
  }
});

// ─── GET /api/v1/progress/achievements ───────────────────────────────────────
// Called by: ProgressAPI.getAchievements()
router.get('/achievements', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const totalLogs = await prisma.workoutLog.count({ where: { userId } });

    // Compute streak for achievement check
    const logs = await prisma.workoutLog.findMany({
      where:   { userId },
      select:  { completedAt: true },
      orderBy: { completedAt: 'desc' },
    });
    const days  = [...new Set(logs.map((l) => l.completedAt.toISOString().split('T')[0]))].sort().reverse();
    let streak  = 0;
    for (let i = 0; i < days.length; i++) {
      if (i === 0) { streak = 1; continue; }
      const diff = (new Date(days[i - 1]).getTime() - new Date(days[i]).getTime()) / 86400000;
      if (diff === 1) streak++; else break;
    }

    // Rule-based achievements
    const achievements = [
      { id: 'first_workout',   name: 'First Step',     description: 'Completed your first workout',       icon: '🎯', unlocked: totalLogs >= 1   },
      { id: 'week_warrior',    name: 'Week Warrior',   description: 'Worked out 7 days in a row',         icon: '🔥', unlocked: streak >= 7      },
      { id: 'century_club',    name: 'Century Club',   description: 'Completed 100 total workouts',       icon: '💯', unlocked: totalLogs >= 100 },
      { id: 'consistent_10',   name: 'Consistent',     description: 'Completed 10 workouts',              icon: '⚡', unlocked: totalLogs >= 10  },
      { id: 'month_streak',    name: 'Month Warrior',  description: 'Worked out 30 days in a row',        icon: '🏆', unlocked: streak >= 30     },
      { id: 'half_century',    name: 'Half Century',   description: 'Completed 50 workouts',              icon: '🌟', unlocked: totalLogs >= 50  },
    ];

    res.status(200).json({ success: true, data: achievements });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch achievements.' });
  }
});

export default router;
