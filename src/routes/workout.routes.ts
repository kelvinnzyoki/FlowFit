import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

const PROGRAM_LOG_PLACEHOLDER_DESCRIPTION =
  'Auto-created from program workout logging because no library Exercise was linked';

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isProgramLogPlaceholder(exercise: any) {
  const description = String(exercise?.description || '').toLowerCase();
  return description.includes(PROGRAM_LOG_PLACEHOLDER_DESCRIPTION.toLowerCase());
}

function libraryExerciseOnlyWhere(extra: Record<string, unknown> = {}) {
  return {
    isActive: true,
    NOT: [
      {
        description: {
          contains: PROGRAM_LOG_PLACEHOLDER_DESCRIPTION,
          mode: 'insensitive',
        },
      },
    ],
    ...extra,
  };
}

function dayExerciseToExerciseLike(dayExercise: any) {
  const linked = dayExercise.exercise && !isProgramLogPlaceholder(dayExercise.exercise)
    ? dayExercise.exercise
    : null;

  return {
    id: linked?.id || dayExercise.exerciseId || dayExercise.id,
    name: linked?.name || dayExercise.exerciseName || 'Program Exercise',
    description: linked?.description || dayExercise.notes || 'Program exercise from your FlowFit training plan.',
    category: linked?.category || 'Program',
    caloriesPerMin: linked?.caloriesPerMin ?? 0,
    isActive: true,
    createdAt: dayExercise.createdAt || new Date(),
    dayExerciseId: dayExercise.id,
    sets: dayExercise.sets,
    reps: dayExercise.reps,
    restSeconds: dayExercise.restSeconds,
    notes: dayExercise.notes,
  };
}

// ─── GET /api/v1/workouts ────────────────────────────────────────────────────
// Frontend receives only real library Exercise rows and normalizes them into
// Workout cards. Program-log placeholder exercises are deliberately hidden.
// Supports: ?category=&q=&limit=&page=
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, q } = req.query as Record<string, string>;
    const take = Math.min(toPositiveInt(req.query.limit, 20), 100);
    const page = toPositiveInt(req.query.page, 1);
    const skip = (page - 1) * take;

    const extraWhere: Record<string, unknown> = {};

    if (category && category !== 'All') extraWhere.category = category;

    if (q && q.trim()) {
      const needle = q.trim();
      extraWhere.OR = [
        { name:        { contains: needle, mode: 'insensitive' } },
        { description: { contains: needle, mode: 'insensitive' } },
        { category:    { contains: needle, mode: 'insensitive' } },
      ];
    }

    const where = libraryExerciseOnlyWhere(extraWhere);

    const [exercises, total] = await Promise.all([
      prisma.exercise.findMany({ where, take, skip, orderBy: { name: 'asc' } }),
      prisma.exercise.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: exercises,
      meta: {
        total,
        page,
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    console.error('Get exercises error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch exercises.' });
  }
});

// ─── GET /api/v1/workouts/search ─────────────────────────────────────────────
// Must stay before /:id so "search" is not treated as an id.
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query as { q?: string };

    if (!q || q.trim().length < 2) {
      res.status(400).json({ success: false, error: 'Search query must be at least 2 characters.' });
      return;
    }

    const needle = q.trim();
    const exercises = await prisma.exercise.findMany({
      where: libraryExerciseOnlyWhere({
        OR: [
          { name:        { contains: needle, mode: 'insensitive' } },
          { description: { contains: needle, mode: 'insensitive' } },
          { category:    { contains: needle, mode: 'insensitive' } },
        ],
      }),
      orderBy: { name: 'asc' },
      take: 20,
    });

    res.status(200).json({ success: true, data: exercises });
  } catch (error) {
    console.error('Search exercises error:', error);
    res.status(500).json({ success: false, error: 'Search failed.' });
  }
});

// ─── GET /api/v1/workouts/:id ─────────────────────────────────────────────────
// Supports both real Exercise.id and DayExercise.id from program detail pages.
// Auto-created program-log placeholder Exercise rows are not treated as library
// exercises, so they cannot pollute the workout/exercise page.
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();

    const exercise = await prisma.exercise.findUnique({ where: { id } });
    if (exercise?.isActive && !isProgramLogPlaceholder(exercise)) {
      res.status(200).json({ success: true, data: exercise });
      return;
    }

    const dayExercise = await prisma.dayExercise.findUnique({
      where: { id },
      include: {
        exercise: true,
        day: {
          include: {
            week: {
              include: {
                program: {
                  select: { id: true, userId: true, isPublic: true, isActive: true },
                },
              },
            },
          },
        },
      },
    });

    if (dayExercise) {
      const authUserId = (req as any).user?.id || (req as any).userId;
      const program = dayExercise.day?.week?.program;

      if (!program?.isActive) {
        res.status(404).json({ success: false, error: 'Exercise not found.' });
        return;
      }

      if (!program.isPublic && program.userId !== authUserId) {
        res.status(403).json({ success: false, error: 'You cannot access this program exercise.' });
        return;
      }

      res.status(200).json({ success: true, data: dayExerciseToExerciseLike(dayExercise) });
      return;
    }

    res.status(404).json({ success: false, error: 'Exercise not found.' });
  } catch (error) {
    console.error('Get exercise by id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch exercise.' });
  }
});

export default router;
