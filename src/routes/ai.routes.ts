import { Router, Request, Response } from 'express';
import { aiService } from '../services/ai.service.js';
import { requireAuth } from '../middleware/auth.middleware.js'; // your existing auth

const router = Router();

router.post('/ai/generate-workout', requireAuth, async (req: Request, res: Response) => {
  try {
    // Safe guard - auth middleware should set this, but we check anyway
    if (!req.user || !req.user.id) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    const preferences = {
      ...req.body,
      userId: req.user.id,
    };

    const plan = await aiService.generateWorkoutPlan(preferences);

    res.json({
      success: true,
      plan,
      message: "Your personalized workout is ready!"
    });
  } catch (error: any) {
    console.error('AI generate error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to generate workout. Please try again." 
    });
  }
});

export default router;
