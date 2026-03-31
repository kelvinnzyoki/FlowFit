import { Router, Response } from 'express';
import { aiService } from '../services/ai.service.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// ─── POST /api/v1/ai/generate-workout ────────────────────────────────────────
// Called by: index.html generateBtn click → apiRequest('/ai/generate-workout', {...})
// Auth: Bearer token required (authenticate middleware)
// Body: { goal, fitnessLevel, equipment[], sessionDuration, trainingDaysPerWeek, limitations? }
router.post('/generate-workout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const {
      goal,
      fitnessLevel,
      equipment,
      sessionDuration,
      trainingDaysPerWeek,
      limitations,
    } = req.body;

    // Basic validation so Grok gets clean input
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

    res.json({
      success: true,
      plan,
      message: 'Workout plan generated successfully!',
    });
  } catch (error: any) {
    console.error('AI route error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to generate workout. Please try again later.',
    });
  }
});

export default router;
