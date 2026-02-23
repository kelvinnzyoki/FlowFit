import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/workouts ────────────────────────────────────────────────────
// Called by: WorkoutsAPI.getExercises(filters)
// Schema model: Exercise (not Workout — your schema uses Exercise for the library)
// Supports: ?category=&difficulty=&muscle=&equipment=&limit=&page=
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      category,
      difficulty,
      muscle,
      equipment,
      limit = '20',
      page  = '1',
    } = req.query as Record<string, string>;

    const take = Math.min(parseInt(limit), 100);
    const skip = (parseInt(page) - 1) * take;

    const where: Record<string, unknown> = { isActive: true };
    if (category)   where.category   = category;
    if (difficulty) where.difficulty = difficulty;
    // targetMuscles and equipment are String[] arrays in the schema — use array contains filter
    if (muscle)     where.targetMuscles = { has: muscle };
    if (equipment)  where.equipment     = { has: equipment };

    const [exercises, total] = await Promise.all([
      prisma.exercise.findMany({ where, take, skip, orderBy: { name: 'asc' } }),
      prisma.exercise.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data:    exercises,
      meta: {
        total,
        page:  parseInt(page),
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
// Called by: WorkoutsAPI.searchExercises(query)
// Must be defined BEFORE /:id so "search" is not treated as an id
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query as { q?: string };

    if (!q || q.trim().length < 2) {
      res.status(400).json({ success: false, error: 'Search query must be at least 2 characters.' });
      return;
    }

    const exercises = await prisma.exercise.findMany({
      where: {
        isActive: true,
        OR: [
          { name:        { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { category:    { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 20,
    });

    res.status(200).json({ success: true, data: exercises });
  } catch (error) {
    console.error('Search exercises error:', error);
    res.status(500).json({ success: false, error: 'Search failed.' });
  }
});

// ─── GET /api/v1/workouts/:id ─────────────────────────────────────────────────
// Called by: WorkoutsAPI.getExerciseById(id)
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const exercise = await prisma.exercise.findUnique({
      where: { id: req.params.id },
    });

    if (!exercise || !exercise.isActive) {
      res.status(404).json({ success: false, error: 'Exercise not found.' });
      return;
    }

    res.status(200).json({ success: true, data: exercise });
  } catch (error) {
    console.error('Get exercise by id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch exercise.' });
  }
});

export default router;
