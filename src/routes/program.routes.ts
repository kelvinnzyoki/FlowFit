import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

function getAuthUserId(req: Request): string | null {
  const r = req as any;
  return r.user?.id || r.userId || r.auth?.userId || r.authUser?.id || null;
}

function requireUserId(req: Request, res: Response): string | null {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return null;
  }
  return userId;
}

function parseJsonMaybe(value: any): any {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  if (typeof value === 'object') return value;
  return {};
}

function titleCase(value: any) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function fallbackExercisesForCategory(category: string) {
  const key = String(category || 'general_fitness').toLowerCase();
  const templates: Record<string, Array<{ name: string; sets: number; reps: string; restSeconds: number; notes: string }>> = {
    strength: [
      { name: 'Push-ups', sets: 3, reps: '10-15', restSeconds: 60, notes: 'Controlled tempo and full range of motion.' },
      { name: 'Squats', sets: 3, reps: '12-18', restSeconds: 60, notes: 'Keep chest tall and knees tracking toes.' },
      { name: 'Lunges', sets: 3, reps: '8-12 each side', restSeconds: 60, notes: 'Step with control and stabilize the hips.' },
      { name: 'Glute Bridges', sets: 3, reps: '12-20', restSeconds: 45, notes: 'Squeeze glutes at the top.' },
    ],
    hiit: [
      { name: 'Jumping Jacks', sets: 4, reps: '30s', restSeconds: 30, notes: 'Stay light on your feet.' },
      { name: 'Mountain Climbers', sets: 4, reps: '30s', restSeconds: 30, notes: 'Keep hips low and core tight.' },
      { name: 'Burpees', sets: 3, reps: '8-12', restSeconds: 45, notes: 'Move fast while keeping clean form.' },
      { name: 'High Knees', sets: 4, reps: '30s', restSeconds: 30, notes: 'Drive knees up and pump arms.' },
    ],
    core: [
      { name: 'Plank', sets: 3, reps: '30-60s', restSeconds: 45, notes: 'Brace your core and keep hips level.' },
      { name: 'Crunches', sets: 3, reps: '15-25', restSeconds: 45, notes: 'Lift from the upper back, not the neck.' },
      { name: 'Russian Twists', sets: 3, reps: '20 total', restSeconds: 45, notes: 'Rotate through the torso.' },
      { name: 'Leg Raises', sets: 3, reps: '10-15', restSeconds: 45, notes: 'Keep lower back controlled.' },
    ],
    mobility: [
      { name: 'Child’s Pose', sets: 2, reps: '45-60s', restSeconds: 20, notes: 'Breathe deeply and relax the back.' },
      { name: 'Downward Dog', sets: 2, reps: '45s', restSeconds: 20, notes: 'Lengthen hamstrings and shoulders.' },
      { name: 'Hip Flexor Stretch', sets: 2, reps: '45s each side', restSeconds: 20, notes: 'Keep ribs stacked over hips.' },
      { name: 'Glute Bridges', sets: 2, reps: '12-15', restSeconds: 30, notes: 'Activate glutes before training.' },
    ],
    conditioning: [
      { name: 'High Knees', sets: 4, reps: '30s', restSeconds: 30, notes: 'Fast cadence and upright posture.' },
      { name: 'Sprint Intervals', sets: 6, reps: '15-20s', restSeconds: 60, notes: 'Explosive effort with full recovery.' },
      { name: 'Mountain Climbers', sets: 4, reps: '30s', restSeconds: 30, notes: 'Drive knees under the chest.' },
      { name: 'Jump Squats', sets: 3, reps: '8-12', restSeconds: 60, notes: 'Land softly and reset.' },
    ],
    general_fitness: [
      { name: 'Push-ups', sets: 3, reps: '8-15', restSeconds: 60, notes: 'Scale to knees or incline if needed.' },
      { name: 'Squats', sets: 3, reps: '12-20', restSeconds: 60, notes: 'Smooth tempo and strong posture.' },
      { name: 'Plank', sets: 3, reps: '30-45s', restSeconds: 45, notes: 'Brace and breathe.' },
      { name: 'Jumping Jacks', sets: 3, reps: '30s', restSeconds: 30, notes: 'Light conditioning finisher.' },
    ],
  };
  return templates[key] || templates.general_fitness;
}

function syntheticWeeksFromMetadata(program: any) {
  const metadata = parseJsonMaybe(program?.metadata);
  const aiPlan = metadata?.aiPlan || metadata?.plan || metadata || {};
  const aiExercises = Array.isArray(aiPlan?.exercises) ? aiPlan.exercises : [];
  const sourceExercises = aiExercises.length > 0 ? aiExercises : fallbackExercisesForCategory(program?.category);
  const durationWeeks = Math.max(1, Number(program?.durationWeeks || 1));
  const daysPerWeek = Math.max(1, Number(program?.daysPerWeek || 1));
  const maxWeeksToMaterialize = Math.min(durationWeeks, 8);

  return Array.from({ length: maxWeeksToMaterialize }, (_, weekIndex) => ({
    id: `synthetic-week-${program.id}-${weekIndex + 1}`,
    weekNumber: weekIndex + 1,
    name: `Week ${weekIndex + 1}`,
    title: `Week ${weekIndex + 1}`,
    description: weekIndex === 0
      ? (aiPlan?.weeklyRecommendations || aiPlan?.scienceNotes || program?.description || '')
      : `Progression week ${weekIndex + 1}`,
    programId: program.id,
    isSynthetic: true,
    days: Array.from({ length: daysPerWeek }, (_, dayIndex) => ({
      id: `synthetic-day-${program.id}-${weekIndex + 1}-${dayIndex + 1}`,
      dayNumber: dayIndex + 1,
      name: daysPerWeek === 1 ? (program?.name || program?.title || 'Workout Day') : `Day ${dayIndex + 1}`,
      title: daysPerWeek === 1 ? (program?.name || program?.title || 'Workout Day') : `Day ${dayIndex + 1}`,
      isRestDay: false,
      isSynthetic: true,
      exercises: sourceExercises.map((ex: any, index: number) => ({
        id: `synthetic-ex-${program.id}-${weekIndex + 1}-${dayIndex + 1}-${index + 1}`,
        orderIndex: index,
        exerciseId: ex.exerciseId || ex.id || null,
        exerciseName: ex.name || ex.exerciseName || `Exercise ${index + 1}`,
        sets: Number(ex.sets) || 3,
        reps: String(ex.reps || '10-15'),
        restSeconds: Number(ex.restSeconds) || 60,
        notes: ex.notes || ex.formTip || '',
        isSynthetic: true,
        exercise: ex.exercise || null,
      })),
    })),
  }));
}

function materializeProgram(program: any) {
  const metadata = parseJsonMaybe(program?.metadata);
  const aiPlan = metadata?.aiPlan || metadata?.plan || {};

  const realWeeks = Array.isArray(program?.weeks) ? program.weeks : [];
  const hasRealWeeks = realWeeks.length > 0 && realWeeks.some((w: any) => Array.isArray(w.days) && w.days.length > 0);
  const weeks = hasRealWeeks ? realWeeks : syntheticWeeksFromMetadata(program);
  const totalDays = weeks.reduce((sum: number, w: any) => sum + (Array.isArray(w.days) ? w.days.length : 0), 0);
  const totalExercises = weeks.reduce((sum: number, w: any) => sum + (Array.isArray(w.days)
    ? w.days.reduce((dSum: number, d: any) => dSum + (Array.isArray(d.exercises) ? d.exercises.length : 0), 0)
    : 0), 0);

  return {
    ...program,
    metadata,
    title: program?.title || program?.name || aiPlan?.workoutName || 'FlowFit Program',
    name: program?.name || program?.title || aiPlan?.workoutName || 'FlowFit Program',
    level: metadata?.level || aiPlan?.level || titleCase(program?.difficulty || 'Intermediate'),
    difficulty: program?.difficulty || metadata?.level || 'intermediate',
    focus: aiPlan?.focus || metadata?.focus || titleCase(program?.category || 'general_fitness'),
    warmUp: aiPlan?.warmUp || null,
    coolDown: aiPlan?.coolDown || null,
    progressionTips: aiPlan?.progressionTips || null,
    scienceNotes: aiPlan?.scienceNotes || null,
    weeklyRecommendations: aiPlan?.weeklyRecommendations || null,
    estimatedDurationMinutes: aiPlan?.estimatedDurationMinutes || null,
    duration: `${program?.durationWeeks || 1} week${Number(program?.durationWeeks || 1) === 1 ? '' : 's'} • ${program?.daysPerWeek || 1} day${Number(program?.daysPerWeek || 1) === 1 ? '' : 's'}/week`,
    weeks,
    totalWeeks: weeks.length,
    totalDays,
    totalExercises,
    hasPersistedSchedule: hasRealWeeks,
    scheduleSource: hasRealWeeks ? 'database' : (Array.isArray(aiPlan?.exercises) && aiPlan.exercises.length ? 'metadata.aiPlan' : 'server-template'),
  };
}

function monthStartUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

const QUOTA_ACTIVE_STATUSES = ['ACTIVE', 'TRIALING', 'GRACE_PERIOD'] as const;

async function getProgramQuotaState(userId: string) {
  const monthStart = monthStartUtc();

  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: QUOTA_ACTIVE_STATUSES as any } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  const planSlug = subscription?.plan?.slug || 'free';
  if (planSlug !== 'free') {
    return { enforce: false, planSlug, max: Number.POSITIVE_INFINITY, used: 0, remaining: Number.POSITIVE_INFINITY, monthStart };
  }

  const freePlan = subscription?.plan || await prisma.plan.findUnique({ where: { slug: 'free' } });
  const max = freePlan?.maxPrograms ?? 2;

  const [initialEnrollmentsThisMonth, restartsThisMonth] = await Promise.all([
    prisma.programEnrollment.count({ where: { userId, createdAt: { gte: monthStart } } }),
    prisma.programEnrollmentUsage.count({ where: { userId, createdAt: { gte: monthStart } } }),
  ]);

  const used = initialEnrollmentsThisMonth + restartsThisMonth;
  return { enforce: true, planSlug, max, used, remaining: Math.max(0, max - used), monthStart };
}

function quotaExceededResponse(res: Response, quota: Awaited<ReturnType<typeof getProgramQuotaState>>) {
  res.status(403).json({
    success: false,
    error: `Free plan allows ${quota.max} program enrollment${quota.max === 1 ? '' : 's'} per month. Upgrade to Pro or Elite to enroll in more programs.`,
    code: 'PROGRAM_LIMIT_REACHED',
    limit: quota.max,
    used: quota.used,
    remaining: quota.remaining,
    resetAt: new Date(Date.UTC(quota.monthStart.getUTCFullYear(), quota.monthStart.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString(),
    upgradeUrl: '/subscription',
  });
}

function accessibleProgramWhere(userId: string, extra: Record<string, any> = {}) {
  return {
    isActive: true,
    ...extra,
    OR: [
      { isPublic: true },
      { userId },
      { enrollments: { some: { userId } } },
    ],
  };
}

function programInclude() {
  return {
    weeks: {
      orderBy: { weekNumber: 'asc' as const },
      include: {
        days: {
          orderBy: { dayNumber: 'asc' as const },
          include: {
            exercises: {
              orderBy: { orderIndex: 'asc' as const },
              include: {
                exercise: {
                  select: { id: true, name: true, description: true, category: true, caloriesPerMin: true },
                },
              },
            },
          },
        },
      },
    },
    _count: { select: { weeks: true, enrollments: true } },
  };
}

// GET /api/v1/programs
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const { difficulty, category, type, mine, limit = '100', page = '1' } = req.query as Record<string, string>;
    const take = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
    const currentPage = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (currentPage - 1) * take;

    const extra: Record<string, any> = {};
    if (difficulty) extra.difficulty = difficulty;
    if (category) extra.category = category;
    if (type) extra.type = type;
    if (mine === 'true') extra.userId = userId;

    const where = mine === 'true'
      ? { isActive: true, userId, ...(difficulty ? { difficulty } : {}), ...(category ? { category } : {}), ...(type ? { type } : {}) }
      : accessibleProgramWhere(userId, extra);

    const [programs, total] = await Promise.all([
      prisma.program.findMany({
        where,
        take,
        skip,
        orderBy: [{ isPublic: 'desc' }, { createdAt: 'desc' }],
        include: programInclude(),
      }),
      prisma.program.count({ where }),
    ]);

    const data = programs.map(materializeProgram);

    res.status(200).json({ success: true, data, meta: { total, page: currentPage, limit: take, pages: Math.ceil(total / take) } });
  } catch (error) {
    console.error('Get programs error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch programs.' });
  }
});

router.get('/my-enrollments', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const enrollments = await prisma.programEnrollment.findMany({
      where: { userId },
      include: { program: { include: programInclude() } },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({ success: true, data: enrollments.map((e: any) => ({ ...e, program: materializeProgram(e.program) })) });
  } catch (error) {
    console.error('Get enrollments error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch your programs.' });
  }
});

router.get('/ai-generated', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const program = await prisma.program.findFirst({
      where: { userId, type: 'ai_generated', isActive: true },
      orderBy: { updatedAt: 'desc' },
      include: programInclude(),
    });
    if (!program) {
      res.status(404).json({ success: false, error: 'No AI program found.' });
      return;
    }
    res.status(200).json({ success: true, data: materializeProgram(program) });
  } catch (error) {
    console.error('Get AI program error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch AI program.' });
  }
});

// GET /api/v1/programs/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const programId = req.params.id;

    const program = await prisma.program.findFirst({
      where: accessibleProgramWhere(userId, { id: programId }),
      include: programInclude(),
    });

    if (!program) {
      res.status(404).json({
        success: false,
        error: 'Program not found or not accessible for this account.',
        code: 'PROGRAM_NOT_ACCESSIBLE',
      });
      return;
    }

    res.status(200).json({ success: true, data: materializeProgram(program) });
  } catch (error) {
    console.error('Get program by id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch program.' });
  }
});

// POST /api/v1/programs
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { name, title, description, category = 'general_fitness', difficulty = 'intermediate', type = 'custom', exercises = [], metadata = {}, durationWeeks = 1, daysPerWeek = 1 } = req.body;
    const programName = String(name || title || '').trim();

    if (!programName) {
      res.status(400).json({ success: false, error: 'Program name is required.' });
      return;
    }

    const exerciseList = Array.isArray(exercises) ? exercises : [];
    const metadataObject = parseJsonMaybe(metadata);

    const weeksCreate = exerciseList.length > 0 ? {
      create: [{
        weekNumber: 1,
        name: 'Week 1',
        description: 'Generated workout week',
        days: {
          create: [{
            dayNumber: 1,
            name: programName,
            isRestDay: false,
            exercises: {
              create: exerciseList.map((ex: any, idx: number) => ({
                orderIndex: ex.order ?? idx,
                exerciseName: ex.name || ex.exerciseName || `Exercise ${idx + 1}`,
                sets: Number(ex.sets) || 3,
                reps: String(ex.reps || '10'),
                restSeconds: Number(ex.restSeconds) || 60,
                notes: ex.notes || ex.formTip || '',
                ...(ex.exerciseId ? { exerciseId: ex.exerciseId } : {}),
              })),
            },
          }],
        },
      }],
    } : undefined;

    const existing = type === 'ai_generated'
      ? await prisma.program.findFirst({ where: { userId, type: 'ai_generated' }, select: { id: true } })
      : null;

    if (existing) {
      await prisma.$transaction(async (tx) => {
        const weeks = await tx.week.findMany({ where: { programId: existing.id }, select: { id: true } });
        for (const week of weeks) {
          const days = await tx.day.findMany({ where: { weekId: week.id }, select: { id: true } });
          for (const day of days) await tx.dayExercise.deleteMany({ where: { dayId: day.id } });
          await tx.day.deleteMany({ where: { weekId: week.id } });
        }
        await tx.week.deleteMany({ where: { programId: existing.id } });
        await tx.program.update({
          where: { id: existing.id },
          data: {
            name: programName,
            description: description || '',
            category,
            difficulty,
            metadata: metadataObject as any,
            durationWeeks: Number(durationWeeks) || 1,
            daysPerWeek: Number(daysPerWeek) || 1,
            ...(weeksCreate ? { weeks: weeksCreate } : {}),
          },
        });
      });
      const updated = await prisma.program.findUnique({ where: { id: existing.id }, include: programInclude() });
      res.status(200).json({ success: true, data: materializeProgram(updated) });
      return;
    }

    const program = await prisma.program.create({
      data: {
        userId,
        name: programName,
        description: description || '',
        category,
        difficulty,
        type,
        metadata: metadataObject as any,
        durationWeeks: Number(durationWeeks) || 1,
        daysPerWeek: Number(daysPerWeek) || 1,
        isActive: true,
        isPublic: false,
        ...(weeksCreate ? { weeks: weeksCreate } : {}),
      },
      include: programInclude(),
    });
    res.status(201).json({ success: true, data: materializeProgram(program) });
  } catch (error) {
    console.error('Create program error:', error);
    res.status(500).json({ success: false, error: 'Failed to create program.' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const programId = req.params.id;
    const existing = await prisma.program.findUnique({ where: { id: programId }, select: { userId: true } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Program not found.' });
      return;
    }
    if (existing.userId !== userId) {
      res.status(403).json({ success: false, error: 'You do not own this program.' });
      return;
    }

    const { name, title, description, category, difficulty, type, metadata, durationWeeks, daysPerWeek } = req.body;
    await prisma.program.update({
      where: { id: programId },
      data: {
        ...(name || title ? { name: String(name || title).trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(category ? { category } : {}),
        ...(difficulty ? { difficulty } : {}),
        ...(type ? { type } : {}),
        ...(metadata !== undefined ? { metadata: parseJsonMaybe(metadata) as any } : {}),
        ...(durationWeeks !== undefined ? { durationWeeks: Number(durationWeeks) || 1 } : {}),
        ...(daysPerWeek !== undefined ? { daysPerWeek: Number(daysPerWeek) || 1 } : {}),
      },
    });

    const updated = await prisma.program.findUnique({ where: { id: programId }, include: programInclude() });
    res.status(200).json({ success: true, data: materializeProgram(updated) });
  } catch (error) {
    console.error('Update program error:', error);
    res.status(500).json({ success: false, error: 'Failed to update program.' });
  }
});

router.post('/:id/enroll', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const programId = req.params.id;

    const program = await prisma.program.findFirst({ where: accessibleProgramWhere(userId, { id: programId }) });
    if (!program) {
      res.status(404).json({ success: false, error: 'Program not found or not accessible for this account.' });
      return;
    }

    const existing = await prisma.programEnrollment.findUnique({ where: { userId_programId: { userId, programId } } });
    if (existing && existing.isActive && !existing.completedAt) {
      res.status(409).json({ success: false, error: 'You are already enrolled in this program.' });
      return;
    }

    const quota = await getProgramQuotaState(userId);
    if (quota.enforce && quota.used >= quota.max) {
      quotaExceededResponse(res, quota);
      return;
    }

    const enrollment = existing
      ? await prisma.programEnrollment.update({ where: { id: existing.id }, data: { startDate: new Date(), currentWeek: 1, currentDay: 1, completedDays: 0, isActive: true, completedAt: null }, include: { program: true } })
      : await prisma.programEnrollment.create({ data: { userId, programId }, include: { program: true } });

    res.status(existing ? 200 : 201).json({ success: true, data: enrollment });
  } catch (error) {
    console.error('Enroll in program error:', error);
    res.status(500).json({ success: false, error: 'Enrollment failed.' });
  }
});

router.post('/:id/restart', async (req: Request, res: Response) => {
  req.url = `/${req.params.id}/enroll`;
  router.handle(req, res, () => undefined);
});

router.put('/enrollments/:enrollmentId/progress', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { enrollmentId } = req.params;
    const { currentWeek, currentDay, completedDays } = req.body;

    const enrollment = await prisma.programEnrollment.findFirst({ where: { id: enrollmentId, userId } });
    if (!enrollment) {
      res.status(404).json({ success: false, error: 'Enrollment not found.' });
      return;
    }

    const updated = await prisma.programEnrollment.update({
      where: { id: enrollmentId },
      data: {
        ...(currentWeek !== undefined ? { currentWeek } : {}),
        ...(currentDay !== undefined ? { currentDay } : {}),
        ...(completedDays !== undefined ? { completedDays } : {}),
      },
      include: { program: true },
    });
    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Update enrollment progress error:', error);
    res.status(500).json({ success: false, error: 'Failed to update progress.' });
  }
});

router.delete('/enrollments/:enrollmentId', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { enrollmentId } = req.params;
    const enrollment = await prisma.programEnrollment.findFirst({ where: { id: enrollmentId, userId } });
    if (!enrollment) {
      res.status(404).json({ success: false, error: 'Enrollment not found.' });
      return;
    }
    const cancelled = await prisma.programEnrollment.update({ where: { id: enrollmentId }, data: { isActive: false }, include: { program: true } });
    res.status(200).json({ success: true, data: cancelled, message: 'Enrollment cancelled.' });
  } catch (error) {
    console.error('Cancel enrollment error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel enrollment.' });
  }
});

export default router;
