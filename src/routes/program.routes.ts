import { Router, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/programs ────────────────────────────────────────────────────
// Called by: ProgramsAPI.getPrograms(filters)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { difficulty, category, limit = '20', page = '1' } = req.query as Record<string, string>;

    const take = Math.min(parseInt(limit), 100);
    const skip = (parseInt(page) - 1) * take;

    const where: Record<string, unknown> = {};
    if (difficulty) where.difficulty = difficulty;
    if (category)   where.category   = category;

    const [programs, total] = await Promise.all([
      prisma.program.findMany({ where, take, skip, orderBy: { createdAt: 'desc' } }),
      prisma.program.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: programs,
      meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) },
    });
  } catch (error) {
    console.error('Get programs error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch programs.' });
  }
});

// ─── GET /api/v1/programs/my-enrollments ────────────────────────────────────
// Called by: ProgramsAPI.getUserPrograms()
// IMPORTANT: defined before /:id so 'my-enrollments' is not treated as an id
router.get('/my-enrollments', async (req: AuthRequest, res: Response) => {
  try {
    const enrollments = await prisma.enrollment.findMany({
      where: { userId: req.user!.id },
      include: { program: true },
      orderBy: { enrolledAt: 'desc' },
    });

    res.status(200).json({ success: true, data: enrollments });
  } catch (error) {
    console.error('Get enrollments error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch your programs.' });
  }
});

// ─── GET /api/v1/programs/:id ────────────────────────────────────────────────
// Called by: ProgramsAPI.getProgramById(id)
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const program = await prisma.program.findUnique({
      where: { id: req.params.id },
      include: { workouts: true },
    });

    if (!program) {
      res.status(404).json({ success: false, error: 'Program not found.' });
      return;
    }

    res.status(200).json({ success: true, data: program });
  } catch (error) {
    console.error('Get program by id error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch program.' });
  }
});

// ─── POST /api/v1/programs/:id/enroll ───────────────────────────────────────
// Called by: ProgramsAPI.enrollInProgram(programId)
router.post('/:id/enroll', async (req: AuthRequest, res: Response) => {
  try {
    const programId = req.params.id;
    const userId    = req.user!.id;

    const program = await prisma.program.findUnique({ where: { id: programId } });
    if (!program) {
      res.status(404).json({ success: false, error: 'Program not found.' });
      return;
    }

    // Prevent duplicate enrollment
    const existing = await prisma.enrollment.findFirst({ where: { userId, programId } });
    if (existing) {
      res.status(409).json({ success: false, error: 'You are already enrolled in this program.' });
      return;
    }

    const enrollment = await prisma.enrollment.create({
      data: { userId, programId, progress: 0 },
      include: { program: true },
    });

    res.status(201).json({ success: true, data: enrollment });
  } catch (error) {
    console.error('Enroll in program error:', error);
    res.status(500).json({ success: false, error: 'Enrollment failed.' });
  }
});

// ─── PUT /api/v1/programs/enrollments/:enrollmentId/progress ─────────────────
// Called by: ProgramsAPI.updateProgress(enrollmentId, data)
router.put('/enrollments/:enrollmentId/progress', async (req: AuthRequest, res: Response) => {
  try {
    const { enrollmentId } = req.params;
    const { progress, completedWorkoutId } = req.body;

    const enrollment = await prisma.enrollment.findFirst({
      where: { id: enrollmentId, userId: req.user!.id },
    });

    if (!enrollment) {
      res.status(404).json({ success: false, error: 'Enrollment not found.' });
      return;
    }

    const updated = await prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        progress:            progress            ?? enrollment.progress,
        completedWorkoutId:  completedWorkoutId  ?? enrollment.completedWorkoutId,
        lastActivityAt:      new Date(),
      },
      include: { program: true },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Update enrollment progress error:', error);
    res.status(500).json({ success: false, error: 'Failed to update progress.' });
  }
});

export default router;
