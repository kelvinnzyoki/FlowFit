import { Router } from 'express';
// Import your sub-routers here as you build them
// import workoutRoutes from './workout.routes.js';
// import authRoutes from './auth.routes.js';

const router = Router();

// Sample route to test the connection
router.get('/test', (req, res) => {
  res.json({ message: 'API Route is working!' });
});

// Example of how you will link sub-routes:
// router.use('/workouts', workoutRoutes);
// router.use('/auth', authLimiter, authRoutes);

export default router;
