// ai.routes.ts — production-ready
import { Router, Request, Response } from 'express';
import { workoutGenerator } from '../services/workoutGenerator.service.js';
import { requireAuth }      from '../middleware/auth.middleware.js';
import { aiCoach }          from '../services/aiCoach.service.js';
import prisma               from '../config/db.js';

const router = Router();

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

    const response = await aiCoach.getResponse(req.user.id, message.trim(), {
      userId:          req.user.id,
      currentExercise: currentExercise ?? undefined,
    });

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

    // ── Step 1: Delete all existing ai_generated programs for this user ──────
    // Cascade delete in schema handles weeks → days → day_exercises automatically.
    const existing = await prisma.program.findMany({
      where:  { userId, type: 'ai_generated' },
      select: { id: true },
    });

    if (existing.length > 0) {
      await prisma.program.deleteMany({
        where: { userId, type: 'ai_generated' },
      });
      console.log(`[ai/save-program] Deleted ${existing.length} old AI program(s) for user ${userId}`);
    }

    // ── Step 2: Create the new program with nested week → day → exercises ────
    // All AI plans are structured as: 1 week → 1 day → N exercises.
    // The exercises array from the frontend maps directly to DayExercise rows.
    const program = await prisma.program.create({
      data: {
        userId,
        name:         name.trim(),
        description:  description || '',
        category,
        difficulty,
        type:         'ai_generated',
        metadata,
        durationWeeks: 1,
        daysPerWeek:   1,
        isActive:      true,
        isPublic:      false,
        weeks: {
          create: {
            weekNumber: 1,
            days: {
              create: {
                dayNumber: 1,
                isRestDay: false,
                exercises: {
                  create: exercises.map((ex: any, i: number) => ({
                    orderIndex:   i,
                    exerciseName: String(ex.name  || `Exercise ${i + 1}`).trim(),
                    sets:         Number(ex.sets)        || 3,
                    reps:         String(ex.reps)        || '10',
                    restSeconds:  Number(ex.restSeconds) || 60,
                    notes:        ex.notes || ex.formTip || null,
                    // exerciseId left null — AI exercises are free-text, not library refs
                  })),
                },
              },
            },
          },
        },
      },
      // Return the full tree so the frontend can confirm structure
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
