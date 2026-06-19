import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

const PLACEHOLDER_DESCRIPTION = 'Auto-created from program workout logging because no library Exercise was linked.';

const ALIAS_TO_EXERCISE_ID: Record<string, string> = {
  pushup: 'ex-pushup',
  pushups: 'ex-pushup',
  'push-ups': 'ex-pushup',
  squat: 'ex-squat',
  squats: 'ex-squat',
  lunge: 'ex-lunge',
  lunges: 'ex-lunge',
  dips: 'ex-dips',
  tricepdips: 'ex-dips',
  'tricep-dips': 'ex-dips',
  glutebridges: 'ex-glute',
  'glute-bridges': 'ex-glute',
  pikepushups: 'ex-pike',
  'pike-pushups': 'ex-pike',
  burpee: 'ex-burpee',
  burpees: 'ex-burpee',
  jumpingjacks: 'ex-jjack',
  'jumping-jacks': 'ex-jjack',
  highknees: 'ex-hknees',
  'high-knees': 'ex-hknees',
  buttkicks: 'ex-bkicks',
  'butt-kicks': 'ex-bkicks',
  plank: 'ex-plank',
  mountainclimbers: 'ex-mclimb',
  'mountain-climbers': 'ex-mclimb',
  crunch: 'ex-crunch',
  crunches: 'ex-crunch',
  russiantwists: 'ex-rtwist',
  'russian-twists': 'ex-rtwist',
  legraises: 'ex-lraise',
  'leg-raises': 'ex-lraise',
  jumpsquats: 'ex-sqjmp',
  'jump-squats': 'ex-sqjmp',
  boxjumps: 'ex-boxjmp',
  'box-jumps': 'ex-boxjmp',
  sprintintervals: 'ex-sprint',
  'sprint-intervals': 'ex-sprint',
  sprints: 'ex-sprint',
  downwarddog: 'ex-ddog',
  'downward-dog': 'ex-ddog',
  childpose: 'ex-child',
  'child-pose': 'ex-child',
  childrenspose: 'ex-child',
  'childs-pose': 'ex-child',
  hipflexorstretch: 'ex-hipfx',
  'hip-flexor-stretch': 'ex-hipfx',
  hipflexor: 'ex-hipfx',
};

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeExerciseKey(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function isPlaceholderDescription(description: unknown) {
  return String(description ?? '').trim() === PLACEHOLDER_DESCRIPTION;
}

function publicExerciseWhere(extra?: Prisma.ExerciseWhereInput): Prisma.ExerciseWhereInput {
  return {
    isActive: true,
    NOT: { description: PLACEHOLDER_DESCRIPTION },
    ...(extra || {}),
  };
}

function dayExerciseToExerciseLike(dayExercise: any) {
  const linked = dayExercise.exercise;
  return {
    id: dayExercise.exerciseId || dayExercise.id,
    name: linked?.name || dayExercise.exerciseName || 'Program Exercise',
    description: linked?.description || dayExercise.notes || 'Program exercise from your FlowFit training plan.',
    category: linked?.category || dayExercise.category || 'Program',
    caloriesPerMin: linked?.caloriesPerMin ?? dayExercise.caloriesPerMin ?? 0,
    isActive: true,
    createdAt: dayExercise.createdAt || new Date(),
    dayExerciseId: dayExercise.id,
    sets: dayExercise.sets,
    reps: dayExercise.reps,
    restSeconds: dayExercise.restSeconds,
    notes: dayExercise.notes,
  };
}

async function findRealExerciseByIdAliasOrName(id: string) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return null;

  const direct = await prisma.exercise.findUnique({ where: { id: trimmed } });
  if (direct?.isActive && !isPlaceholderDescription(direct.description)) return direct;

  const normalized = normalizeExerciseKey(trimmed);
  const aliasId = ALIAS_TO_EXERCISE_ID[trimmed.toLowerCase()] || ALIAS_TO_EXERCISE_ID[normalized];

  if (aliasId && aliasId !== trimmed) {
    const aliasExercise = await prisma.exercise.findUnique({ where: { id: aliasId } });
    if (aliasExercise?.isActive && !isPlaceholderDescription(aliasExercise.description)) return aliasExercise;
  }

  const candidates = await prisma.exercise.findMany({
    where: publicExerciseWhere(),
    take: 200,
    orderBy: { name: 'asc' },
  });

  return candidates.find((exercise) => {
    const keys = [exercise.id, exercise.name].map(normalizeExerciseKey);
    return keys.includes(normalized);
  }) || null;
}

// ─── GET /api/v1/workouts ────────────────────────────────────────────────────
// Frontend receives Exercise rows and normalizes them into Workout cards.
// Supports: ?category=&q=&limit=&page=
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, q } = req.query as Record<string, string>;
    const take = Math.min(toPositiveInt(req.query.limit, 20), 100);
    const page = toPositiveInt(req.query.page, 1);
    const skip = (page - 1) * take;

    const where: Prisma.ExerciseWhereInput = publicExerciseWhere();

    if (category && category !== 'All') where.category = category;

    if (q && q.trim()) {
      const needle = q.trim();
      where.OR = [
        { name: { contains: needle, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: needle, mode: Prisma.QueryMode.insensitive } },
        { category: { contains: needle, mode: Prisma.QueryMode.insensitive } },
      ];
    }

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
      where: publicExerciseWhere({
        OR: [
          { name: { contains: needle, mode: Prisma.QueryMode.insensitive } },
          { description: { contains: needle, mode: Prisma.QueryMode.insensitive } },
          { category: { contains: needle, mode: Prisma.QueryMode.insensitive } },
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
// Supports real Exercise.id, common frontend aliases such as "childpose", and
// DayExercise.id from program detail pages. Placeholder auto-created exercises
// are intentionally ignored so they do not shadow the real library exercises.
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();

    const exercise = await findRealExerciseByIdAliasOrName(id);
    if (exercise) {
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
