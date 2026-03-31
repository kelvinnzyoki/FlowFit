import { Router, Request, Response } from 'express';
import { aiService } from '../services/ai.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/generate-workout', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const plan = await aiService.generateWorkoutPlan({
      ...req.body,
      userId: req.user.id,
    });

    res.json({
      success: true,
      plan,
      message: 'Workout plan generated successfully!'
    });
  } catch (error: any) {
    console.error('AI route error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to generate workout. Please try again later.'
    });
  }
});

export default router;
