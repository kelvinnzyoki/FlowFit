import express from "express";
import { fetchExercises } from "./exercise.service";

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
