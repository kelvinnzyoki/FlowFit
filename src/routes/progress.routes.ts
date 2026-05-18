// Path: src/routes/progress.routes.ts
import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';
import { checkAndNotifyMilestones } from '../services/notification.service.js';

const router = Router();

router.use(authenticate);

async function resolveLoggableExerciseId(rawExerciseId: string, body: any): Promise<string> {
  const exerciseId = String(rawExerciseId || '').trim();
  if (!exerciseId) throw new Error('exerciseId is required.');

  const existing = await prisma.exercise.findUnique({ where: { id: exerciseId } });
  if (existing) return existing.id;

  // If the frontend accidentally sent a DayExercise.id, map it to the linked
  // Exercise.id when available. This fixes DB-backed program days.
  const dayExercise = await prisma.dayExercise.findUnique({
    where: { id: exerciseId },
    include: { exercise: true },
  });
  if (dayExercise?.exerciseId && dayExercise.exercise) return dayExercise.exerciseId;

  // AI/custom day exercises may not map to a library Exercise. WorkoutLog.exerciseId
  // is required by schema, so create a safe custom Exercise record and log against it.
  const customName =
    body.exerciseName ||
    body.name ||
    dayExercise?.exerciseName ||
    'Custom Program Exercise';

  const customCategory = body.category || 'CUSTOM';
  const customCalories = Number(body.caloriesPerMin ?? body.calories_per_min ?? 0);

  const created = await prisma.exercise.create({
    data: {
      id: exerciseId,
      name: String(customName).slice(0, 120),
      description: 'Auto-created from program workout logging because no library Exercise was linked.',
      category: String(customCategory).slice(0, 60),
      caloriesPerMin: Number.isFinite(customCalories) && customCalories >= 0 ? customCalories : 0,
      isActive: true,
    },
  });

  return created.id;
}

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
      bodyWeight,
      bodyWeightKg,
      weight,
    } = req.body;

    if (!exerciseId || !duration) {
      res.status(400).json({ success: false, error: 'exerciseId and duration are required.' });
      return;
    }

    const resolvedExerciseId = await resolveLoggableExerciseId(exerciseId, req.body);

    const log = await prisma.workoutLog.create({
      data: {
        userId,
        exerciseId: resolvedExerciseId,
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

    // Optional body-weight snapshot from workout session. This is separate from
    // exercise/set weight and feeds the Progress → Weight Trend card.
    const sessionBodyWeightRaw = bodyWeight ?? bodyWeightKg ?? weight;
    const sessionBodyWeight = sessionBodyWeightRaw !== undefined && sessionBodyWeightRaw !== null && sessionBodyWeightRaw !== ''
      ? Number(sessionBodyWeightRaw)
      : null;

    if (sessionBodyWeight !== null && Number.isFinite(sessionBodyWeight) && sessionBodyWeight > 0 && sessionBodyWeight <= 500) {
      const profile = await prisma.profile.findUnique({
        where: { userId },
        select: { height: true },
      });

      let bmi: number | null = null;
      if (profile?.height && profile.height > 0) {
        const heightM = profile.height / 100;
        bmi = Number((sessionBodyWeight / (heightM * heightM)).toFixed(1));
      }

      await prisma.$transaction([
        prisma.userMetrics.create({
          data: {
            userId,
            weight: sessionBodyWeight,
            bmi,
            notes: 'Logged from workout session',
          },
        }),
        prisma.profile.upsert({
          where: { userId },
          update: { weight: sessionBodyWeight },
          create: { userId, weight: sessionBodyWeight },
        }),
      ]);
    }

    // Update streak and check milestone notifications after every logged workout.
    // Both are fire-and-forget — failures must never block the workout log response.
    await updateStreak(userId);
    checkAndNotifyMilestones(userId).catch(err =>
      console.error('[progress] milestone check failed:', err)
    );

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


// ─── POST /api/v1/progress/metrics ───────────────────────────────────────────
// Called by: Profile page and Workout Session page when user logs body metrics.
// IMPORTANT: Weight trend requires historical UserMetrics rows. Updating only
// Profile.weight changes the current value but gives the chart no history.
router.post('/metrics', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const weight = req.body.weight ?? req.body.weightKg ?? req.body.bodyWeight ?? req.body.bodyWeightKg;
    const bodyFat = req.body.bodyFat ?? req.body.bodyFatPct;
    const muscleMass = req.body.muscleMass;
    const restingHeartRate = req.body.restingHeartRate ?? req.body.heartRate;
    const notes = req.body.notes;
    const dateInput = req.body.date;

    const weightNum = weight !== undefined && weight !== null && weight !== '' ? Number(weight) : null;
    const bodyFatNum = bodyFat !== undefined && bodyFat !== null && bodyFat !== '' ? Number(bodyFat) : null;
    const muscleMassNum = muscleMass !== undefined && muscleMass !== null && muscleMass !== '' ? Number(muscleMass) : null;
    const restingHeartRateNum = restingHeartRate !== undefined && restingHeartRate !== null && restingHeartRate !== '' ? Number(restingHeartRate) : null;

    if (
      weightNum === null &&
      bodyFatNum === null &&
      muscleMassNum === null &&
      restingHeartRateNum === null
    ) {
      res.status(400).json({ success: false, error: 'At least one metric value is required.' });
      return;
    }

    if (weightNum !== null && (!Number.isFinite(weightNum) || weightNum <= 0 || weightNum > 500)) {
      res.status(400).json({ success: false, error: 'Weight must be a valid number between 1 and 500 kg.' });
      return;
    }

    if (bodyFatNum !== null && (!Number.isFinite(bodyFatNum) || bodyFatNum < 0 || bodyFatNum > 80)) {
      res.status(400).json({ success: false, error: 'Body fat must be a valid percentage between 0 and 80.' });
      return;
    }

    if (muscleMassNum !== null && (!Number.isFinite(muscleMassNum) || muscleMassNum <= 0 || muscleMassNum > 300)) {
      res.status(400).json({ success: false, error: 'Muscle mass must be a valid number between 1 and 300 kg.' });
      return;
    }

    if (
      restingHeartRateNum !== null &&
      (!Number.isFinite(restingHeartRateNum) || restingHeartRateNum < 30 || restingHeartRateNum > 220)
    ) {
      res.status(400).json({ success: false, error: 'Resting heart rate must be between 30 and 220 bpm.' });
      return;
    }

    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: { height: true },
    });

    let bmi: number | null = null;
    if (weightNum !== null && profile?.height && profile.height > 0) {
      const heightM = profile.height / 100;
      bmi = Number((weightNum / (heightM * heightM)).toFixed(1));
    }

    const metric = await prisma.userMetrics.create({
      data: {
        userId,
        date: dateInput ? new Date(dateInput) : new Date(),
        weight: weightNum,
        bodyFat: bodyFatNum,
        muscleMass: muscleMassNum,
        restingHeartRate: restingHeartRateNum !== null ? Math.round(restingHeartRateNum) : null,
        bmi,
        notes: notes ? String(notes).slice(0, 500) : null,
      },
    });

    // Keep Profile.weight current too, so BMI/current profile cards update.
    if (weightNum !== null) {
      await prisma.profile.upsert({
        where: { userId },
        update: { weight: weightNum },
        create: { userId, weight: weightNum },
      });
    }

    res.status(201).json({ success: true, data: metric });
  } catch (error) {
    console.error('Log metrics error:', error);
    res.status(500).json({ success: false, error: 'Failed to log metrics.' });
  }
});

// ─── GET /api/v1/progress/metrics/history ────────────────────────────────────
// Returns newest first. The progress page uses this for Weight Trend.
router.get('/metrics/history', async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '30', 10) || 30, 1), 365);

    const metrics = await prisma.userMetrics.findMany({
      where: {
        userId: req.user!.id,
        OR: [
          { weight: { not: null } },
          { bodyFat: { not: null } },
          { muscleMass: { not: null } },
          { bmi: { not: null } },
          { restingHeartRate: { not: null } },
        ],
      },
      orderBy: { date: 'desc' },
      take: limit,
    });

    res.status(200).json({ success: true, data: metrics });
  } catch (error) {
    console.error('Get metrics history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics history.' });
  }
});


// ─── POST /api/v1/progress/achievements/recalculate ──────────────────────────
// Called by: ProgressAPI.recalculateAchievements()
// Evaluates every Achievement's requirement against the user's actual DB data
// and writes/removes UserAchievement rows accordingly.
// Returns the same shape as GET /achievements so the frontend can use it directly.
router.post('/achievements/recalculate', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    // Fetch everything needed in parallel
    const [allAchievements, userAchievements, logs, streak] = await Promise.all([
      prisma.achievement.findMany({ orderBy: { points: 'asc' } }),
      prisma.userAchievement.findMany({
        where:  { userId },
        select: { achievementId: true, unlockedAt: true },
      }),
      prisma.workoutLog.findMany({
        where:  { userId },
        select: { caloriesBurned: true, duration: true, date: true },
      }),
      prisma.streak.findUnique({ where: { userId } }),
    ]);

    // Aggregate lifetime stats from actual WorkoutLog rows
    const totalWorkouts = logs.length;
    const totalCalories = logs.reduce((s, l) => s + (l.caloriesBurned ?? 0), 0);
    const totalDuration = logs.reduce((s, l) => s + l.duration, 0);
    const currentStreak = streak?.currentStreak ?? 0;
    const longestStreak = streak?.longestStreak ?? 0;

    const alreadyUnlocked = new Set(userAchievements.map((ua) => ua.achievementId));

    console.log(`[recalculate] userId=${userId} workouts=${totalWorkouts} kcal=${Math.round(totalCalories)} dur=${totalDuration}min streak=${currentStreak}/${longestStreak}`);

    // Evaluate each achievement requirement against real lifetime DB data.
    // requirement is a Prisma Json field — we support every key name variant
    // that exists in seed files so no requirement shape is silently skipped.
    for (const ach of allAchievements) {
      let met = false;
      try {
        const req: any = typeof ach.requirement === 'string'
          ? JSON.parse(ach.requirement as string)
          : ach.requirement;

        if (!req || typeof req !== 'object') continue;

        // Threshold: try every possible key name used across seed versions
        const threshold = Number(
          req.value    ?? req.count    ?? req.target   ??
          req.workouts ?? req.calories ?? req.duration ?? req.streak ??
          req.sessions ?? req.total    ?? 0
        );
        if (threshold <= 0) continue; // requirement has no numeric target — skip

        // Type: normalise from type, field, metric, or category key
        const type = String(req.type || req.field || req.metric || req.category || '').toLowerCase();

        if (type.includes('workout') || type.includes('session') || type.includes('count') || type === '') {
          // Empty type defaults to workout count (most common requirement)
          met = totalWorkouts >= threshold;
        } else if (type.includes('calor')) {
          met = totalCalories >= threshold;
        } else if (type.includes('dur') || type.includes('minute') || type.includes('hour')) {
          met = totalDuration >= threshold;
        } else if (type.includes('streak')) {
          // Accept if EITHER current OR longest streak ever hit the threshold
          met = currentStreak >= threshold || longestStreak >= threshold;
        }
        // Unknown type — do not grant

        console.log(`[recalculate]   ${ach.name}: type="${type}" threshold=${threshold} met=${met} (already=${alreadyUnlocked.has(ach.id)})`);
      } catch {
        console.warn(`[recalculate] malformed requirement for achievement ${ach.id}`);
        continue;
      }

      if (met && !alreadyUnlocked.has(ach.id)) {
        await prisma.userAchievement.upsert({
          where:  { userId_achievementId: { userId, achievementId: ach.id } },
          create: { userId, achievementId: ach.id },
          update: {},
        });
        console.log(`[recalculate]   ✅ GRANTED: ${ach.name}`);
      }
      // Achievements are never revoked once earned.
    }

    // Re-fetch updated userAchievements and return same shape as GET /achievements
    const updatedUA = await prisma.userAchievement.findMany({
      where:  { userId },
      select: { achievementId: true, unlockedAt: true },
    });
    const unlockedMap = new Map(updatedUA.map((ua) => [ua.achievementId, ua.unlockedAt]));

    const data = allAchievements.map((a) => ({
      ...a,
      unlocked:   unlockedMap.has(a.id),
      unlockedAt: unlockedMap.get(a.id) ?? null,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Recalculate achievements error:', error);
    res.status(500).json({ success: false, error: 'Failed to recalculate achievements.' });
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
    // Explicit UTC midnight dates — prevents timezone-related streak resets.
    // setHours(0,0,0,0) uses the server's local timezone (UTC on Vercel), which can
    // misalign with users in UTC+ timezones and silently reset streaks to 1.
    const now          = new Date();
    const todayUTC     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yesterdayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));

    const existing = await prisma.streak.findUnique({ where: { userId } });

    if (!existing) {
      await prisma.streak.create({
        data: { userId, currentStreak: 1, longestStreak: 1, lastWorkoutDate: todayUTC },
      });
      return;
    }

    // Normalise stored date to UTC midnight for a timezone-safe comparison
    let lastUTC: Date | null = null;
    if (existing.lastWorkoutDate) {
      const l = new Date(existing.lastWorkoutDate);
      lastUTC = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
    }

    // Already logged today — no update needed
    if (lastUTC && lastUTC.getTime() === todayUTC.getTime()) return;

    const isConsecutive = lastUTC && lastUTC.getTime() === yesterdayUTC.getTime();
    const newCurrent    = isConsecutive ? existing.currentStreak + 1 : 1;
    const newLongest    = Math.max(existing.longestStreak, newCurrent);

    await prisma.streak.update({
      where: { userId },
      data:  { currentStreak: newCurrent, longestStreak: newLongest, lastWorkoutDate: todayUTC },
    });
  } catch (err) {
    // Non-fatal — streak failure should never block workout logging
    console.error('Streak update failed:', err);
  }
}

export default router;
