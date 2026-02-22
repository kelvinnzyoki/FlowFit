import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// All workout routes require authentication
router.use(authenticate);

// ─── GET /api/v1/workouts ────────────────────────────────────────────────────
// Called by: WorkoutsAPI.getExercises(filters)
// Supports query params: category, difficulty, muscle, limit, page
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { category, difficulty, muscle, limit = '20', page = '1' } = req.query as Record<string, string>;

    const take = Math.min(parseInt(limit), 100);
    const skip = (parseInt(page) - 1) * take;

    const where: Record<string, unknown> = {};
    if (category)   where.category   = category;
    if (difficulty) where.difficulty = difficulty;
    if (muscle)     where.muscleGroup = muscle;

    const [workouts, total] = await Promise.all([
      prisma.workout.findMany({ where, take, skip, orderBy: { createdAt: 'desc' } }),
      prisma.workout.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: workouts,
      meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) },
    });
  } catch (error) {
    console.error('Get workouts error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch workouts.' });
  }
});

// ─── GET /api/v1/workouts/search ────────────────────────────────────────────
// Called by: WorkoutsAPI.searchExercises(query)
// IMPORTANT: this must be defined BEFORE /:id to avoid 'search' being treated as an id
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query as { q?: string };

    if (!q || q.trim().length < 2) {
      res.status(400).json({ success: false, error: 'Search query must be at least 2 characters.' });
      return;
    }

    const workouts = await prisma.workout.findMany({
      where: {
        OR: [
          { name:        { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { category:    { contains: q, mode: 'insensitive' } },
          { muscleGroup: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 20,
    });

    res.status(200).json({ success: true, data: workouts });
  } catch (error) {
    console.error('Search workouts error:', error);
    res.status(500).json({ success: false, error: 'Search failed.' });
  }
});

// ─── GET /api/v1/workouts/:id ────────────────────────────────────────────────
// Called by: WorkoutsAPI.getExerciseById(id)
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const workout = await prisma.workout.findUnique({ where: { id: req.params.id } });

    if (!workout) {
      res.status(404).json({ success: false, error: 'Workout not found.' });
      return;
    }

    res.status(200).json({ success: true, data: workout });
  } catch (error) {
    console.error('Get workout by id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch workout.' });
  }
});

export default router;
