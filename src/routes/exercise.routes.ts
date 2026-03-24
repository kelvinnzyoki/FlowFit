import { Request, Response, NextFunction } from 'express';
import { fetchExercises } from "./exercise.service.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const exercises = await fetchExercises();
    res.json(exercises);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch exercises" });
  }
});

export default router;
