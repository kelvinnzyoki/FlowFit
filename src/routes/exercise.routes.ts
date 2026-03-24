import { Router, Request, Response } from 'express';
import { fetchExercises } from '../services/exercise.service.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const exercises = await fetchExercises();
    res.json(exercises);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch exercises' });
  }
});

export default router;
