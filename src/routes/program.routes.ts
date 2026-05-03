import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate);

// ─── GET /api/v1/programs ─────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      difficulty,
      category,
      isPublic,   // replaces the old (wrong) isPremium — Program has isPublic, not isPremium
      type,
      mine,
      limit = '20',
      page  = '1',
    } = req.query as Record<string, string>;

    const take = Math.min(parseInt(limit), 100);
    const skip = (parseInt(page) - 1) * take;

    const where: Record<string, unknown> = {};
    if (difficulty) where.difficulty = difficulty;
    if (category)   where.category   = category;
    if (type)       where.type       = type;
    if (isPublic !== undefined) where.isPublic = isPublic === 'true';

    // mine=true — only show programs created by the current user
    if (mine === 'true') where.userId = req.user!.id;

    const [programs, total] = await Promise.all([
      prisma.program.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { weeks: true, enrollments: true } } },
      }),
      prisma.program.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data:    programs,
      meta: {
        total,
        page:  parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    console.error('Get programs error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch programs.' });
  }
});

// ─── GET /api/v1/programs/my-enrollments ─────────────────────────────────────
// Called by: ProgramsAPI.getUserPrograms()
// Must be defined BEFORE /:id so Express doesn't treat "my-enrollments" as an id.
router.get('/my-enrollments', async (req: Request, res: Response) => {
  try {
    const enrollments = await prisma.programEnrollment.findMany({
      where:   { userId: req.user!.id },
      include: {
        program: {
          include: { _count: { select: { weeks: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({ success: true, data: enrollments });
  } catch (error) {
    console.error('Get enrollments error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch your programs.' });
  }
});

// ─── GET /api/v1/programs/ai-generated ───────────────────────────────────────
// Returns the current user's single AI-generated program with full exercise data.
// Profile page calls this to display the saved plan without relying on localStorage.
router.get('/ai-generated', async (req: Request, res: Response) => {
  try {
    const program = await prisma.program.findFirst({
      where:   { userId: req.user!.id, type: 'ai_generated' },
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
      res.status(404).json({ success: false, error: 'No AI program found.' });
      return;
    }

    res.status(200).json({ success: true, data: program });
  } catch (error) {
    console.error('Get AI program error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch AI program.' });
  }
});

// ─── POST /api/v1/programs ────────────────────────────────────────────────────
// For type='ai_generated': upserts — replaces the user's existing AI program
// so they always have exactly one. New exercises replace old ones entirely.
// For other types: always creates a new program.
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      name,
      description,
      category    = 'general_fitness',
      difficulty  = 'intermediate',
      type        = 'custom',
      exercises   = [],
      metadata    = {},
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, error: 'Program name is required.' });
      return;
    }

    // For AI programs — find and replace existing one so the user has exactly one.
    if (type === 'ai_generated') {
      const existing = await prisma.program.findFirst({
        where:  { userId, type: 'ai_generated' },
        select: { id: true },
      });

      if (existing) {
        // Delete the old nested structure then update in a single transaction
        await prisma.$transaction(async (tx) => {
          const weeks = await tx.week.findMany({
            where:  { programId: existing.id },
            select: { id: true },
          });
          for (const week of weeks) {
            const days = await tx.day.findMany({
              where:  { weekId: week.id },
              select: { id: true },
            });
            for (const day of days) {
              await tx.dayExercise.deleteMany({ where: { dayId: day.id } });
            }
            await tx.day.deleteMany({ where: { weekId: week.id } });
          }
          await tx.week.deleteMany({ where: { programId: existing.id } });

          await tx.program.update({
            where: { id: existing.id },
            data: {
              name:         name.trim(),
              description:  description || '',
              category,
              difficulty,
              metadata:     metadata as any,
              durationWeeks: 1,
              daysPerWeek:   1,
              weeks: exercises.length > 0 ? {
                create: [{
                  weekNumber:  1,
                  name:       'Week 1',
                  description: 'AI-generated workout',
                  days: {
                    create: [{
                      dayNumber: 1,
                      name:     name.trim(),
                      isRestDay: false,
                      exercises: {
                        create: exercises.map((ex: any, idx: number) => ({
                          orderIndex:   ex.order  ?? idx,
                          exerciseName: ex.name   || `Exercise ${idx + 1}`,
                          sets:         Number(ex.sets)        || 3,
                          reps:         String(ex.reps)        || '10',
                          restSeconds:  Number(ex.restSeconds) || 60,
                          notes:        ex.notes  || ex.formTip || '',
                          ...(ex.exerciseId ? { exerciseId: ex.exerciseId } : {}),
                        })),
                      },
                    }],
                  },
                }],
              } : undefined,
            },
          });
        });

        const updated = await prisma.program.findUnique({
          where:   { id: existing.id },
          include: {
            weeks: {
              include: {
                days: {
                  include: {
                    exercises: { orderBy: { orderIndex: 'asc' } },
                  },
                },
              },
            },
            _count: { select: { weeks: true, enrollments: true } },
          },
        });
        res.status(200).json({ success: true, data: updated });
        return;
      }
    }

    // No existing AI program (or non-AI type) — create fresh
    const weeksCreate = type === 'ai_generated' && exercises.length > 0
      ? {
          create: [{
            weekNumber:  1,
            name:       'Week 1',
            description: 'AI-generated workout',
            days: {
              create: [{
                dayNumber:  1,
                name:      name.trim(),
                isRestDay:  false,
                exercises: {
                  create: exercises.map((ex: any, idx: number) => ({
                    orderIndex:   ex.order ?? idx,
                    exerciseName: ex.name  || `Exercise ${idx + 1}`,
                    sets:         Number(ex.sets)        || 3,
                    reps:         String(ex.reps)        || '10',
                    restSeconds:  Number(ex.restSeconds) || 60,
                    notes:        ex.notes || ex.formTip || '',
                    ...(ex.exerciseId ? { exerciseId: ex.exerciseId } : {}),
                  })),
                },
              }],
            },
          }],
        }
      : undefined;

    const program = await prisma.program.create({
      data: {
        userId,
        name:          name.trim(),
        description:   description || '',
        category,
        difficulty,
        type,
        metadata:      metadata as any,
        durationWeeks: 1,
        daysPerWeek:   1,
        isActive:      true,
        isPublic:      false,
        ...(weeksCreate ? { weeks: weeksCreate } : {}),
      },
      include: {
        weeks: {
          include: {
            days: {
              include: {
                exercises: { orderBy: { orderIndex: 'asc' } },
              },
            },
          },
        },
        _count: { select: { weeks: true, enrollments: true } },
      },
    });
    res.status(201).json({ success: true, data: program });
  } catch (error) {
    console.error('Create program error:', error);
    res.status(500).json({ success: false, error: 'Failed to create program.' });
  }
});

// ─── PATCH /api/v1/programs/:id ───────────────────────────────────────────────
// Called by: ProgramsAPI.saveAiProgram() when an existing AI program is found.
// Replaces the program's content in-place — the user only ever has one AI program.
//
// Security: only the owner can update their own program.
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const userId    = req.user!.id;
    const programId = req.params.id;

    const {
      name,
      description,
      category,
      difficulty,
      type,
      exercises = [],
      metadata  = {},
    } = req.body;

    // Ownership check — never let one user overwrite another's program
    const existing = await prisma.program.findUnique({
      where:  { id: programId },
      select: { userId: true, type: true },
    });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Program not found.' });
      return;
    }
    if (existing.userId !== userId) {
      res.status(403).json({ success: false, error: 'You do not own this program.' });
      return;
    }

    // For AI programs: delete old weeks/days/exercises then recreate them
    // so we always reflect the latest generated plan exactly.
    if ((type ?? existing.type) === 'ai_generated' && exercises.length > 0) {
      await prisma.$transaction(async (tx) => {
        // Delete existing nested structure
        const weeks = await tx.week.findMany({
          where:   { programId },
          select:  { id: true },
        });
        for (const week of weeks) {
          const days = await tx.day.findMany({
            where:  { weekId: week.id },
            select: { id: true },
          });
          for (const day of days) {
            await tx.dayExercise.deleteMany({ where: { dayId: day.id } });
          }
          await tx.day.deleteMany({ where: { weekId: week.id } });
        }
        await tx.week.deleteMany({ where: { programId } });

        // Recreate with the new exercises — always reset to 1 week / 1 day for AI plans
        await tx.program.update({
          where: { id: programId },
          data: {
            ...(name        && { name: name.trim() }),
            ...(description !== undefined && { description }),
            ...(category    && { category }),
            ...(difficulty  && { difficulty }),
            metadata:     metadata as any,
            durationWeeks: 1,
            daysPerWeek:   1,
            updatedAt:    new Date(),
            weeks: {
              create: [{
                weekNumber:  1,
                name:       'Week 1',
                description: 'AI-generated workout',
                days: {
                  create: [{
                    dayNumber: 1,
                    name:     name?.trim() ?? 'AI Generated Workout',
                    isRestDay: false,
                    exercises: {
                      create: exercises.map((ex: any, idx: number) => ({
                        orderIndex:   ex.order ?? idx,
                        exerciseName: ex.name  || `Exercise ${idx + 1}`,
                        sets:         Number(ex.sets)        || 3,
                        reps:         String(ex.reps)        || '10',
                        restSeconds:  Number(ex.restSeconds) || 60,
                        notes:        ex.notes || ex.formTip || '',
                        ...(ex.exerciseId ? { exerciseId: ex.exerciseId } : {}),
                      })),
                    },
                  }],
                },
              }],
            },
          },
        });
      });
    } else {
      // Non-AI program or no exercises supplied — update top-level fields only
      await prisma.program.update({
        where: { id: programId },
        data: {
          ...(name        && { name: name.trim() }),
          ...(description !== undefined && { description }),
          ...(category    && { category }),
          ...(difficulty  && { difficulty }),
          ...(type        && { type }),
          metadata: metadata as any,
          updatedAt: new Date(),
        },
      });
    }

    const updated = await prisma.program.findUnique({
      where:   { id: programId },
      include: { _count: { select: { weeks: true, enrollments: true } } },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Update program error:', error);
    res.status(500).json({ success: false, error: 'Failed to update program.' });
  }
});

// ─── GET /api/v1/programs/:id ─────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const program = await prisma.program.findUnique({
      where:   { id: req.params.id },
      include: {
        weeks: {
          orderBy: { weekNumber: 'asc' },
          include: {
            days: {
              orderBy: { dayNumber: 'asc' },
              include: {
                exercises: {
                  orderBy: { orderIndex: 'asc' },
                  include: {
                    exercise: {
                      select: {
                        id:          true,
                        name:        true,
                        description: true,
                        category:    true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
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

// ─── POST /api/v1/programs/:id/enroll ────────────────────────────────────────
// Called by: ProgramsAPI.enrollInProgram(programId)
router.post('/:id/enroll', async (req: Request, res: Response) => {
  try {
    const programId = req.params.id;
    const userId    = req.user!.id;

    const program = await prisma.program.findUnique({ where: { id: programId } });
    if (!program) {
      res.status(404).json({ success: false, error: 'Program not found.' });
      return;
    }

    const existing = await prisma.programEnrollment.findUnique({
      where: { userId_programId: { userId, programId } },
    });
    if (existing) {
      res.status(409).json({ success: false, error: 'You are already enrolled in this program.' });
      return;
    }

    const enrollment = await prisma.programEnrollment.create({
      data:    { userId, programId },
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
router.put('/enrollments/:enrollmentId/progress', async (req: Request, res: Response) => {
  try {
    const { enrollmentId }                        = req.params;
    const { currentWeek, currentDay, completedDays } = req.body;

    const enrollment = await prisma.programEnrollment.findFirst({
      where: { id: enrollmentId, userId: req.user!.id },
    });
    if (!enrollment) {
      res.status(404).json({ success: false, error: 'Enrollment not found.' });
      return;
    }

    const program = await prisma.program.findUnique({
      where:  { id: enrollment.programId },
      select: { durationWeeks: true, daysPerWeek: true },
    });

    const totalDays    = (program?.durationWeeks ?? 0) * (program?.daysPerWeek ?? 0);
    const newCompleted = completedDays ?? enrollment.completedDays;
    const isCompleted  = totalDays > 0 && newCompleted >= totalDays;

    const updated = await prisma.programEnrollment.update({
      where: { id: enrollmentId },
      data:  {
        ...(currentWeek   !== undefined && { currentWeek }),
        ...(currentDay    !== undefined && { currentDay }),
        ...(completedDays !== undefined && { completedDays }),
        ...(isCompleted && { completedAt: new Date(), isActive: false }),
      },
      include: { program: true },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Update enrollment progress error:', error);
    res.status(500).json({ success: false, error: 'Failed to update progress.' });
  }
});

// ─── DELETE /api/v1/programs/enrollments/:enrollmentId ───────────────────────
// Called by: ProgramsAPI.cancelEnrollment(enrollmentId)
// Removes the enrollment so the user can re-enroll from scratch.
router.delete('/enrollments/:enrollmentId', async (req: Request, res: Response) => {
  try {
    const { enrollmentId } = req.params;

    const enrollment = await prisma.programEnrollment.findFirst({
      where: { id: enrollmentId, userId: req.user!.id },
    });
    if (!enrollment) {
      res.status(404).json({ success: false, error: 'Enrollment not found.' });
      return;
    }

    await prisma.programEnrollment.delete({ where: { id: enrollmentId } });

    res.status(200).json({ success: true, message: 'Enrollment cancelled.' });
  } catch (error) {
    console.error('Cancel enrollment error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel enrollment.' });
  }
});

export default router;
