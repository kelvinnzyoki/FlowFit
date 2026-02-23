import { Router, Request, Response } from 'express';
import authRoutes         from './auth.routes.js';
import workoutRoutes      from './workout.routes.js';
import programRoutes      from './program.routes.js';
import progressRoutes     from './progress.routes.js';
import userRoutes         from './user.routes.js';
import subscriptionRoutes from './subscription.routes.js';

const router = Router();

// ─── Smoke test ──────────────────────────────────────────────────────────────
router.get('/test', (req: Request, res: Response) => {
  res.json({ success: true, message: 'FlowFit API is running ✅' });
});

// ─── Auth — rate limiting applied inside auth.routes.ts ──────────────────────
router.use('/auth', authRoutes);

// ─── Protected resource routes ───────────────────────────────────────────────
// JWT authentication is applied inside each router via the authenticate middleware
router.use('/workouts',      workoutRoutes);
router.use('/programs',      programRoutes);
router.use('/progress',      progressRoutes);
router.use('/users',         userRoutes);
router.use('/subscriptions', subscriptionRoutes);

import app from '../src/server.js';

export default app;
