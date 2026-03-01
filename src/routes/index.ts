// src/routes/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Master router — wires all sub-routes under /api/v1
// Mounted in server.ts via: app.use('/api/v1', routes)
//
// Full API surface:
//   POST   /api/v1/auth/register
//   POST   /api/v1/auth/login
//   POST   /api/v1/auth/logout
//   POST   /api/v1/auth/refresh
//   GET    /api/v1/auth/me
//   POST   /api/v1/auth/change-password
//
//   GET    /api/v1/workouts
//   GET    /api/v1/workouts/search
//   GET    /api/v1/workouts/:id
//
//   GET    /api/v1/programs
//   GET    /api/v1/programs/my-enrollments
//   GET    /api/v1/programs/:id
//   POST   /api/v1/programs/:id/enroll
//   PUT    /api/v1/programs/enrollments/:enrollmentId/progress
//
//   POST   /api/v1/progress
//   GET    /api/v1/progress/me
//   GET    /api/v1/progress/stats
//   GET    /api/v1/progress/history
//   GET    /api/v1/progress/streaks
//   GET    /api/v1/progress/achievements
//
//   GET    /api/v1/users/me
//   PUT    /api/v1/users/me
//   POST   /api/v1/users/metrics
//   GET    /api/v1/users/metrics/history
//
//   GET    /api/v1/subscriptions/me
//   POST   /api/v1/subscriptions/checkout
//   POST   /api/v1/subscriptions/cancel
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import authRoutes         from './auth.routes.js';
import workoutRoutes      from './workout.routes.js';
import programRoutes      from './program.routes.js';
import progressRoutes     from './progress.routes.js';
import userRoutes         from './user.routes.js';
import subscriptionRoutes from './subscription.routes.js';
import seedRoute from './seed.route.js';
router.use('/seed', seedRoute);
 

const router = Router();

// ─── Smoke test ──────────────────────────────────────────────────────────────
router.get('/test', (req: Request, res: Response) => {
  res.json({ success: true, message: 'FlowFit API is running ✅' });
});

// ─── Auth ────────────────────────────────────────────────────────────────────
// Rate limiting on login/register is applied inside auth.routes.ts
router.use('/auth', authRoutes);

// ─── Protected resource routes ───────────────────────────────────────────────
// JWT authentication is applied inside each router via authenticate middleware
router.use('/workouts',      workoutRoutes);
router.use('/programs',      programRoutes);
router.use('/progress',      progressRoutes);
router.use('/users',         userRoutes);
router.use('/subscriptions', subscriptionRoutes);

export default router;
