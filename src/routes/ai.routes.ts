// ai.routes.ts — production-ready
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { workoutGenerator } from '../services/workoutGenerator.service.js';
import { requireAuth }      from '../middleware/auth.middleware.js';
import { aiCoach }          from '../services/aiCoach.service.js';
import prisma               from '../config/db.js';

const router = Router();


async function programHasTitleColumn(tx: any): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'programs'
         AND column_name = 'title'
     ) AS exists`
  );
  return Boolean(rows?.[0]?.exists);
}

function normalizeAiExercises(exercises: any[]): Array<{
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  notes: string | null;
}> {
  return exercises.map((ex: any, i: number) => ({
    name:        String(ex?.name || `Exercise ${i + 1}`).trim(),
    sets:        Number(ex?.sets) || 3,
    reps:        String(ex?.reps || '10'),
    restSeconds: Number(ex?.restSeconds) || 60,
    notes:       ex?.notes || ex?.formTip || null,
  }));
}

async function createAiProgramWithLiveDbCompatibility(tx: any, args: {
  userId: string;
  name: string;
  description: string;
  category: string;
  difficulty: string;
  metadata: any;
  exercises: any[];
}) {
  const cleanName = args.name.trim();
  const cleanExercises = normalizeAiExercises(args.exercises);
  const hasTitleColumn = await programHasTitleColumn(tx);

  let programId: string | null = null;

  if (hasTitleColumn) {
    // Some live databases still have a NOT NULL `title` column from an older schema.
    // Prisma schema now uses `name`, so Prisma cannot write `title` directly.
    // Use a narrow raw insert only for the Program row, then use Prisma for child rows.
    programId = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO programs (
         id, "userId", title, name, description, category, difficulty, type, metadata,
         "isActive", "isPublic", "durationWeeks", "daysPerWeek", "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'ai_generated', $8::jsonb,
         true, false, 1, 1, NOW(), NOW()
       )`,
      programId,
      args.userId,
      cleanName,
      cleanName,
      args.description || '',
      args.category || 'general_fitness',
      args.difficulty || 'intermediate',
      JSON.stringify(args.metadata ?? {})
    );
  } else {
    const program = await tx.program.create({
      data: {
        userId:        args.userId,
        name:          cleanName,
        description:   args.description || '',
        category:      args.category || 'general_fitness',
        difficulty:    args.difficulty || 'intermediate',
        type:          'ai_generated',
        metadata:      args.metadata ?? {},
        durationWeeks: 1,
        daysPerWeek:   1,
        isActive:      true,
        isPublic:      false,
      },
      select: { id: true },
    });
    programId = program.id;
  }

  await tx.week.create({
    data: {
      programId,
      weekNumber: 1,
      days: {
        create: {
          dayNumber: 1,
          isRestDay: false,
          exercises: {
            create: cleanExercises.map((ex, i) => ({
              orderIndex:   i,
              exerciseName: ex.name,
              sets:         ex.sets,
              reps:         ex.reps,
              restSeconds:  ex.restSeconds,
              notes:        ex.notes,
            })),
          },
        },
      },
    },
  });

  return tx.program.findUnique({
    where: { id: programId },
    include: {
      weeks: {
        include: {
          days: {
            include: {
              exercises: {
                orderBy: { orderIndex: 'asc' },
              },
            },
          },
        },
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────
// POST /api/v1/ai/generate-workout
// ─────────────────────────────────────────────────────────────
const handleGenerateWorkout = async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const plan = await workoutGenerator.generateWorkoutPlan({
      goal:                req.body.goal || req.body.fitnessGoal || 'general_fitness',
      fitnessLevel:        req.body.fitnessLevel || req.body.level || 'beginner',
      equipment:           Array.isArray(req.body.equipment) && req.body.equipment.length ? req.body.equipment : ['bodyweight'],
      sessionDuration:     Number(req.body.sessionDuration || req.body.minutes || 30),
      trainingDaysPerWeek: Number(req.body.trainingDaysPerWeek || req.body.daysPerWeek || 3),
      limitations:         req.body.limitations || req.body.injuries || undefined,
      userId:              req.user.id,
    });

    res.json({
      success: true,
      data: plan,
      plan,
      message: 'Your personalized workout plan is ready!',
    });
  } catch (error: any) {
    console.error('[Route] generate-workout error:', error?.message ?? error);
    res.status(500).json({ success: false, message: 'Failed to generate workout. Please try again.' });
  }
};

router.post('/generate-workout', requireAuth, handleGenerateWorkout);
router.post('/generate-workout-plan', requireAuth, handleGenerateWorkout);
router.post('/generate-plan', requireAuth, handleGenerateWorkout);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/ai/suggest-progression
// ─────────────────────────────────────────────────────────────
router.post('/suggest-progression', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { exerciseName, lastSets, lastReps, lastRPE } = req.body;

    if (!exerciseName || lastSets === undefined || lastReps === undefined) {
      return res.status(400).json({ success: false, message: 'exerciseName, lastSets, and lastReps are required' });
    }

    const suggestion = await workoutGenerator.suggestProgression(
      req.user.id,
      exerciseName,
      Number(lastSets),
      String(lastReps),
      lastRPE ? Number(lastRPE) : undefined,
    );

    res.json({ success: true, suggestion });
  } catch (error: any) {
    console.error('[Route] suggest-progression error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to generate progression suggestion' });
  }
});


type CoachHistoryExchange = {
  id: string;
  user: string;
  assistant: string;
  createdAt: string;
};

function normalizeCoachHistory(value: any): CoachHistoryExchange[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item: any) =>
      item &&
      typeof item === 'object' &&
      typeof item.user === 'string' &&
      typeof item.assistant === 'string'
    )
    .map((item: any) => ({
      id:        typeof item.id === 'string' ? item.id : randomUUID(),
      user:      item.user.slice(0, 2000),
      assistant: item.assistant.slice(0, 6000),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    }))
    .slice(-6);
}

async function loadCoachHistory(userId: string): Promise<CoachHistoryExchange[]> {
  const row = await prisma.userMemory.findUnique({ where: { userId } });
  const memory = row?.data && typeof row.data === 'object' ? (row.data as any) : {};
  return normalizeCoachHistory(memory.coachHistory);
}

async function appendCoachExchange(userId: string, userMessage: string, coachReply: string): Promise<void> {
  if (!userId || !userMessage || !coachReply) return;

  const row = await prisma.userMemory.findUnique({ where: { userId } });
  const memory = row?.data && typeof row.data === 'object' ? (row.data as any) : {};
  const history = normalizeCoachHistory(memory.coachHistory);

  const nextHistory = [
    ...history,
    {
      id:        randomUUID(),
      user:      userMessage.slice(0, 2000),
      assistant: coachReply.slice(0, 6000),
      createdAt: new Date().toISOString(),
    },
  ].slice(-6);

  await prisma.userMemory.upsert({
    where:  { userId },
    update: { data: { ...memory, coachHistory: nextHistory } as any },
    create: { userId, data: { coachHistory: nextHistory } as any },
  });
}

// ─────────────────────────────────────────────────────────────
// GET /api/v1/ai/coach/history
//
// Returns only the latest 6 user/coach exchanges for the current user.
// Stored in user_memories.data.coachHistory so no new table/migration is needed.
// ─────────────────────────────────────────────────────────────
router.get('/coach/history', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const history = await loadCoachHistory(req.user.id);
    res.json({ success: true, data: history });
  } catch (error: any) {
    console.error('[Route] /coach/history error:', error);
    res.status(500).json({ success: false, message: 'Failed to load coach history.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/ai/coach
// ─────────────────────────────────────────────────────────────
router.post('/coach', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const { message, currentExercise } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ success: false, message: 'Message too long (max 2000 chars)' });
    }

    const cleanMessage = message.trim();

    const response = await aiCoach.getResponse(req.user.id, cleanMessage, {
      userId:          req.user.id,
      currentExercise: currentExercise ?? undefined,
    });

    if (response?.success && typeof response.reply === 'string' && response.reply.trim()) {
      await appendCoachExchange(req.user.id, cleanMessage, response.reply);
    }

    res.json(response);
  } catch (error: any) {
    console.error('[Route] /coach error:', error);
    res.status(500).json({ success: false, message: 'Coach is taking a quick rest. Please try again.' });
  }
});


function materializeGeneratedWorkoutPlan(plan: any) {
  const exercises = Array.isArray(plan?.exercises) ? plan.exercises : [];
  const metadata = parseJsonForGeneratedPlan(plan?.metadata);
  return {
    ...plan,
    title: plan?.name || metadata?.workoutName || 'Generated Workout Plan',
    type: 'generated_workout_plan',
    isGeneratedPlan: true,
    exercises,
    metadata,
    weeks: [
      {
        id: `generated-week-${plan.id}`,
        weekNumber: 1,
        name: 'Generated Plan',
        days: [
          {
            id: `generated-day-${plan.id}`,
            dayNumber: 1,
            name: plan?.name || 'Generated Workout',
            isRestDay: false,
            exercises: exercises.map((ex: any, index: number) => ({
              id: `generated-ex-${plan.id}-${index + 1}`,
              orderIndex: Number(ex?.order ?? ex?.orderIndex ?? index),
              exerciseName: ex?.name || ex?.exerciseName || `Exercise ${index + 1}`,
              sets: Number(ex?.sets) || 3,
              reps: String(ex?.reps || '10-15'),
              restSeconds: Number(ex?.restSeconds) || 60,
              notes: ex?.notes || ex?.formTip || '',
              exerciseId: ex?.exerciseId || null,
              exercise: ex?.exercise || null,
            })),
          },
        ],
      },
    ],
  };
}

function parseJsonForGeneratedPlan(value: any) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

// ─────────────────────────────────────────────────────────────
// POST /api/v1/ai/save-program
//
// Saves an AI-generated workout plan for the authenticated user.
// Always REPLACES the previous ai_generated program so the user
// has exactly one at all times. Safe to call on every new plan.
//
// Body: {
//   name:        string
//   description: string
//   category:    string
//   difficulty:  string
//   exercises:   { name, sets, reps, restSeconds, notes, order }[]
//   metadata:    object   (full AI plan for display)
// }
// ─────────────────────────────────────────────────────────────
router.post('/save-program', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const userId = req.user.id;
    const {
      name,
      description = '',
      category    = 'general_fitness',
      difficulty  = 'intermediate',
      exercises   = [],
      metadata    = {},
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Program name is required' });
    }

    if (!Array.isArray(exercises) || exercises.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one exercise is required' });
    }

    const savedPlan = await prisma.$transaction(async (tx) => {
      await tx.generatedWorkoutPlan.updateMany({
        where: { userId, isActive: true },
        data:  { isActive: false },
      });

      return tx.generatedWorkoutPlan.create({
        data: {
          userId,
          name:        name.trim(),
          description: String(description || ''),
          category:    String(category || 'general_fitness'),
          difficulty:  String(difficulty || 'intermediate'),
          metadata:    metadata || {},
          exercises,
          isActive:    true,
        },
      });
    });

    res.status(201).json({
      success: true,
      message: 'AI workout plan saved successfully.',
      data:    materializeGeneratedWorkoutPlan(savedPlan),
    });

  } catch (error: any) {
    console.error('[Route] /save-program error:', error?.message ?? error);
    res.status(500).json({
      success: false,
      message: 'Failed to save workout plan. Please try again.',
      error:   process.env.NODE_ENV !== 'production' ? error?.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/ai/saved-program
//
// Returns the user's current AI-generated program with full
// exercise data. Profile page calls this on load.
// Returns 404 if no program has been saved yet — not an error.
// ─────────────────────────────────────────────────────────────
router.get('/saved-program', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const userId = req.user.id;

    const savedPlan = await prisma.generatedWorkoutPlan.findFirst({
      where:   { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!savedPlan) {
      return res.status(404).json({
        success: false,
        message: 'No AI-generated workout plan found. Generate a workout plan first.',
      });
    }

    res.json({ success: true, data: materializeGeneratedWorkoutPlan(savedPlan) });

  } catch (error: any) {
    console.error('[Route] /saved-program error:', error?.message ?? error);
    res.status(500).json({ success: false, message: 'Failed to fetch saved workout plan.' });
  }
});

export default router;
