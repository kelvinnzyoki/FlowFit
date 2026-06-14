import { Router, type Request, type Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();
const prisma = new PrismaClient();

type AuthedRequest = Request & {
  user?: {
    id?: string;
    userId?: string;
    email?: string;
    role?: string;
  };
};

function getUserId(req: AuthedRequest): string | undefined {
  return req.user?.id || req.user?.userId;
}

function normalizeProgram(program: any, enrollment?: any) {
  const weeks = Array.isArray(program?.weeks)
    ? program.weeks.map((week: any) => ({
        id: week.id,
        weekNumber: week.weekNumber,
        title: week.name || `Week ${week.weekNumber}`,
        name: week.name || `Week ${week.weekNumber}`,
        description: week.description || '',
        days: Array.isArray(week.days)
          ? week.days.map((day: any) => ({
              id: day.id,
              dayNumber: day.dayNumber,
              title: day.name || `Day ${day.dayNumber}`,
              name: day.name || `Day ${day.dayNumber}`,
              isRestDay: day.isRestDay,
              exercises: Array.isArray(day.exercises)
                ? day.exercises.map((de: any) => {
                    const ex = de.exercise || null;
                    return {
                      id: ex?.id || de.exerciseId || de.id,
                      dayExerciseId: de.id,
                      exerciseId: de.exerciseId,
                      name: ex?.name || de.exerciseName || 'Exercise',
                      exerciseName: de.exerciseName || ex?.name || 'Exercise',
                      category: ex?.category || 'STRENGTH',
                      description: ex?.description || de.notes || '',
                      caloriesPerMin: Number(ex?.caloriesPerMin ?? 0),
                      orderIndex: de.orderIndex ?? 0,
                      sets: de.sets,
                      reps: de.reps,
                      restSeconds: de.restSeconds,
                      notes: de.notes,
                      exercise: ex,
                    };
                  })
                : [],
            }))
          : [],
      }))
    : [];

  return {
    id: program.id,
    userId: program.userId,
    title: program.name,
    name: program.name,
    description: program.description || '',
    category: program.category,
    focus: program.category,
    level: program.difficulty,
    difficulty: program.difficulty,
    type: program.type,
    metadata: program.metadata,
    isActive: program.isActive,
    isPublic: program.isPublic,
    durationWeeks: program.durationWeeks,
    daysPerWeek: program.daysPerWeek,
    weeks,
    enrollment: enrollment || program.enrollments?.[0] || null,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
}

const programInclude = {
  weeks: {
    orderBy: { weekNumber: 'asc' as const },
    include: {
      days: {
        orderBy: { dayNumber: 'asc' as const },
        include: {
          exercises: {
            orderBy: { orderIndex: 'asc' as const },
            include: {
              exercise: true,
            },
          },
        },
      },
    },
  },
  enrollments: true,
};

// GET /api/v1/programs
// Protected: returns only programs the current user can open.
router.get('/', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const programs = await prisma.program.findMany({
      where: {
        isActive: true,
        OR: [
          { isPublic: true },
          { userId },
          { enrollments: { some: { userId } } },
        ],
      },
      orderBy: [{ isPublic: 'desc' }, { createdAt: 'desc' }],
      include: {
        enrollments: {
          where: { userId },
          take: 1,
        },
        weeks: {
          select: {
            id: true,
            weekNumber: true,
            days: {
              select: { id: true },
            },
          },
        },
      },
    });

    const data = programs.map((p: any) => normalizeProgram(p, p.enrollments?.[0] || null));

    return res.json({ success: true, data, programs: data });
  } catch (error) {
    console.error('[programs:list]', error);
    return res.status(500).json({ success: false, error: 'Failed to load programs' });
  }
});

// GET /api/v1/programs/enrollments/me
router.get('/enrollments/me', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const enrollments = await prisma.programEnrollment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        program: {
          include: programInclude,
        },
      },
    });

    return res.json({ success: true, data: enrollments, enrollments });
  } catch (error) {
    console.error('[programs:enrollments]', error);
    return res.status(500).json({ success: false, error: 'Failed to load enrollments' });
  }
});

// GET /api/v1/programs/:id
// Protected detail. Must return full weeks -> days -> exercises.
router.get('/:id', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const program = await prisma.program.findUnique({
      where: { id },
      include: {
        ...programInclude,
        enrollments: {
          where: { userId },
          take: 1,
        },
      },
    });

    if (!program || !program.isActive) {
      return res.status(404).json({ success: false, error: 'Program not found' });
    }

    const userEnrollment = program.enrollments?.[0] || null;
    const canAccess = program.isPublic || program.userId === userId || Boolean(userEnrollment);

    if (!canAccess) {
      // Return 404 instead of 403 so inaccessible private IDs do not leak.
      return res.status(404).json({ success: false, error: 'Program not found' });
    }

    const data = normalizeProgram(program, userEnrollment);

    return res.json({ success: true, data, program: data });
  } catch (error) {
    console.error('[programs:detail]', error);
    return res.status(500).json({ success: false, error: 'Failed to load program detail' });
  }
});

// POST /api/v1/programs/:id/enroll
router.post('/:id/enroll', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const program = await prisma.program.findUnique({ where: { id } });
    if (!program || !program.isActive) {
      return res.status(404).json({ success: false, error: 'Program not found' });
    }

    if (!program.isPublic && program.userId !== userId) {
      return res.status(403).json({ success: false, error: 'You cannot enroll in this private program' });
    }

    const enrollment = await prisma.programEnrollment.upsert({
      where: { userId_programId: { userId, programId: id } },
      update: {
        isActive: true,
        completedAt: null,
        updatedAt: new Date(),
      },
      create: {
        userId,
        programId: id,
        currentWeek: 1,
        currentDay: 1,
        completedDays: 0,
        isActive: true,
      },
    });

    await prisma.programEnrollmentUsage.create({
      data: {
        userId,
        programId: id,
        enrollmentId: enrollment.id,
        action: 'ENROLL',
      },
    }).catch(() => null);

    return res.json({ success: true, data: enrollment, enrollment });
  } catch (error: any) {
    console.error('[programs:enroll]', error);
    return res.status(500).json({ success: false, error: 'Failed to enroll in program' });
  }
});

// POST /api/v1/programs/:id/restart
router.post('/:id/restart', authenticate, async (req: AuthedRequest, res: Response) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const enrollment = await prisma.programEnrollment.upsert({
      where: { userId_programId: { userId, programId: id } },
      update: {
        currentWeek: 1,
        currentDay: 1,
        completedDays: 0,
        isActive: true,
        completedAt: null,
        updatedAt: new Date(),
      },
      create: {
        userId,
        programId: id,
        currentWeek: 1,
        currentDay: 1,
        completedDays: 0,
        isActive: true,
      },
    });

    await prisma.programEnrollmentUsage.create({
      data: {
        userId,
        programId: id,
        enrollmentId: enrollment.id,
        action: 'RESTART',
      },
    }).catch(() => null);

    return res.json({ success: true, data: enrollment, enrollment });
  } catch (error) {
    console.error('[programs:restart]', error);
    return res.status(500).json({ success: false, error: 'Failed to restart program' });
  }
});

export default router;
