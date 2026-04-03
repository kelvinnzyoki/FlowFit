import { Router, Request, Response } from 'express';
import { workoutGenerator } from '../services/workoutGenerator.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/generate-workout', requireAuth, async (req: Request, res: Response) => {
  try {
    // Safe guard for req.user
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

router.post('/suggest-progression', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

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
      Number(lastSets),
      String(lastReps),
      lastRPE ? Number(lastRPE) : undefined
    );

    res.json({ success: true, suggestion });
  } catch (error: any) {
    console.error('Progression suggestion error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate progression suggestion' 
    });
  }
});

router.post('/coach', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { message, currentExercise } = req.body;

    const response = await aiCoach.getResponse(req.user.id, message, {
      userId: req.user.id,
      currentExercise
    });

    res.json({ success: true, ...response });
  } catch (error: any) {
    console.error('AI Coach error:', error);
    res.status(500).json({ success: false, message: 'Coach is taking a quick rest.' });
  }
});


export default router;
