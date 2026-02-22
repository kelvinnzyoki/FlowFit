import { Router, Request, Response } from 'express';
import authRoutes         from './auth.routes.js';
import workoutRoutes      from './workout.routes.js';
import programRoutes      from './program.routes.js';
import progressRoutes     from './progress.routes.js';
import userRoutes         from './user.routes.js';
import subscriptionRoutes from './subscription.routes.js';
import { authLimiter }    from '../middleware/rateLimiter.js';

const router = Router();

// ─── Health / smoke test ─────────────────────────────────────────────────────
router.get('/test', (req: Request, res: Response) => {
  res.json({ success: true, message: 'FlowFit API is running ✅' });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Auth — strict rate-limit on login/register is applied inside auth.routes.ts
router.use('/auth', authRoutes);

// Protected resource routes — JWT auth is applied inside each router
router.use('/workouts',      workoutRoutes);
router.use('/programs',      programRoutes);
router.use('/progress',      progressRoutes);
router.use('/users',         userRoutes);
router.use('/subscriptions', subscriptionRoutes);

export default router;
