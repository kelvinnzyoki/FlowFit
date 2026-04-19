// ai.routes.ts — production-ready
// Fix: aiCoach import now matches singleton export from service

import { Router, Request, Response } from 'express';
import { workoutGenerator } from '../services/workoutGenerator.service.js';
import { requireAuth }      from '../middleware/auth.middleware.js';
import { aiCoach }          from '../services/aiCoach.service.js'; // ✅ singleton matches export

const router = Router();

// ─────────────────────────────────────────────────────────────
// POST /api/ai/generate-workout
// ─────────────────────────────────────────────────────────────

router.post('/generate-workout', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const plan = await workoutGenerator.generateWorkoutPlan({
      ...req.body,
      userId: req.user.id,
    });

    res.json({
      success: true,
      plan,
      message: 'Your personalized workout plan is ready!',
    });
  } catch (error: any) {
    console.error('[Route] generate-workout error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to generate workout. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/suggest-progression
// ─────────────────────────────────────────────────────────────

router.post('/suggest-progression', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { exerciseName, lastSets, lastReps, lastRPE } = req.body;

    if (!exerciseName || lastSets === undefined || lastReps === undefined) {
      return res.status(400).json({
        success: false,
        message: 'exerciseName, lastSets, and lastReps are required',
      });
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
// POST /api/ai/coach
// ─────────────────────────────────────────────────────────────

router.post('/coach', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { message, currentExercise } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    // Guard against absurdly large messages
    if (message.length > 2000) {
      return res.status(400).json({ success: false, message: 'Message too long (max 2000 chars)' });
    }

    // ✅ Calls getResponse() — matches service method (fix #3)
    const response = await aiCoach.getResponse(req.user.id, message.trim(), {
      userId:          req.user.id,
      currentExercise: currentExercise ?? undefined,
    });

    // Service already returns { success, reply, data? } — send directly
    res.json(response);

  } catch (error: any) {
    console.error('[Route] /coach error:', error);
    res.status(500).json({
      success: false,
      message: 'Coach is taking a quick rest. Please try again.',
    });
  }
});

export default router;
