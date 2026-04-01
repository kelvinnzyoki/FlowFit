import { Router, Request, Response } from 'express';
import { workoutGenerator } from '../services/workoutGenerator.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Main endpoint called by the AI Modal
router.post('/generate-workout', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    const plan = await workoutGenerator.generateWorkoutPlan({
      ...req.body,
      userId: req.user.id,
    });

    res.json({
      success: true,
      plan,
      message: 'Your personalized workout plan is ready!'
    });
  } catch (error: any) {
    console.error('Workout generator error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate workout. Please try again.' 
    });
  }
});

// NEW: Get progressive overload suggestion after logging a workout
router.post('/suggest-progression', requireAuth, async (req: Request, res: Response) => {
  try {
    const { exerciseName, lastSets, lastReps, lastRPE } = req.body;

    if (!exerciseName || !lastSets || !lastReps) {
      return res.status(400).json({ 
        success: false, 
        message: 'exerciseName, lastSets, and lastReps are required' 
      });
    }

    const suggestion = await workoutGenerator.suggestProgression(
      req.user.id,
      exerciseName,
      parseInt(lastSets),
      lastReps,
      lastRPE ? parseInt(lastRPE) : undefined
    );

    res.json({
      success: true,
      suggestion
    });
  } catch (error: any) {
    console.error('Progression suggestion error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate progression suggestion' 
    });
  }
});

export default router;
