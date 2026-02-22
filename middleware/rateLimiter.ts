import rateLimit from 'express-rate-limit';

// Standard limiter: 100 requests per 15 minutes
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, 
  standardHeaders: true, 
  legacyHeaders: false,
  message: {
    status: 429,
    message: 'Too many requests, please try again later.',
  },
});

// You can create a stricter one for Auth (Login/Register) later
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, 
  message: 'Too many login attempts. Please try again in an hour.',
});
