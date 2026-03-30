import { Router } from 'express';
import { aiService } from '../services/ai.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
// Optional: requirePlan middleware for Pro+

const router = Router();

router.post('/ai/generate-workout', requireAuth, async (req, res) => {
  try {
    const preferences = {
      ...req.body,
      userId: req.user.id, // from your auth middleware
    };

    const plan = await aiService.generateWorkoutPlan(preferences);

    res.json({
      success: true,
      plan,
      message: "Your personalized workout is ready!"
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to generate workout" });
  }
});

export default router;
