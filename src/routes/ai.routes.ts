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
router.post('/generate-workout', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Authentication required' });

    const plan = await workoutGenerator.generateWorkoutPlan({
      ...req.body,
      userId: req.user.id,
    });

    res.json({ success: true, plan, message: 'Your personalized workout plan is ready!' });
  } catch (error: any) {
    console.error('[Route] generate-workout error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to generate workout. Please try again.' });
  }
});

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

    const program = await prisma.$transaction(async (tx) => {
      const existing = await tx.program.findMany({
        where:  { userId, type: 'ai_generated' },
        select: { id: true },
      });

      if (existing.length > 0) {
        await tx.program.deleteMany({ where: { userId, type: 'ai_generated' } });
        console.log(`[ai/save-program] Deleted ${existing.length} old AI program(s) for user ${userId}`);
      }

      return createAiProgramWithLiveDbCompatibility(tx, {
        userId,
        name,
        description,
        category,
        difficulty,
        metadata,
        exercises,
      });
    });

    if (!program) {
      return res.status(500).json({ success: false, message: 'Failed to save workout program. Please try again.' });
    }

    console.log(`[ai/save-program] Saved program "${program.name}" (${program.id}) for user ${userId} with ${exercises.length} exercise(s)`);

    res.status(201).json({
      success: true,
      message: 'AI workout program saved successfully.',
      data:    program,
    });

  } catch (error: any) {
    console.error('[Route] /save-program error:', error?.message ?? error);
    res.status(500).json({
      success: false,
      message: 'Failed to save workout program. Please try again.',
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

    const program = await prisma.program.findFirst({
      where:   { userId, type: 'ai_generated' },
      orderBy: { updatedAt: 'desc' },
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

    if (!program) {
      return res.status(404).json({
        success: false,
        message: 'No AI-generated program found. Generate a workout plan first.',
      });
    }

    res.json({ success: true, data: program });

  } catch (error: any) {
    console.error('[Route] /saved-program error:', error?.message ?? error);
    res.status(500).json({ success: false, message: 'Failed to fetch saved program.' });
  }
});

export default router;
