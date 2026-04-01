import { Router, Response } from 'express';
import { aiService } from '../services/ai.service.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// ─── POST /api/v1/ai/generate-workout ────────────────────────────────────────
router.post('/generate-workout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const { goal, fitnessLevel, equipment, sessionDuration, trainingDaysPerWeek, limitations } = req.body;

    if (!goal || !fitnessLevel) {
      res.status(400).json({ success: false, message: 'goal and fitnessLevel are required.' });
      return;
    }

    const plan = await aiService.generateWorkoutPlan({
      goal,
      fitnessLevel,
      equipment:           Array.isArray(equipment) ? equipment : [],
      sessionDuration:     parseInt(sessionDuration)     || 45,
      trainingDaysPerWeek: parseInt(trainingDaysPerWeek) || 4,
      limitations:         limitations || undefined,
      userId:              req.user.id,
    });

    res.json({ success: true, plan, message: 'Workout plan generated successfully!' });

  } catch (error: any) {
    // Surface the real error message so the frontend can show exactly what went wrong.
    // This is the key fix — the old code buried every error under a generic message.
    const message = error?.message || 'Unknown error generating workout plan.';
    console.error('[AI route] generateWorkoutPlan failed:', message);

    const status = message.includes('XAI_API_KEY') || message.includes('invalid or expired') ? 401
                 : message.includes('rate limit') ? 429
                 : 500;

    res.status(status).json({ success: false, message });
  }
});

export default router;
