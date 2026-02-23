import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis.js';

// Build a Redis-backed store if Redis is available, otherwise fall back to
// the default in-memory store (fine for local dev, broken on serverless).
const buildStore = () => {
  if (redis) {
    return new RedisStore({
      // rate-limit-redis uses sendCommand to stay client-agnostic
      sendCommand: (...args: string[]) => redis.call(...args) as Promise<unknown>,
    });
  }
  console.warn(
    'Rate limiter: Redis unavailable, falling back to in-memory store. ' +
    'Rate limits will NOT be shared across serverless instances.'
  );
  return undefined; // express-rate-limit default (MemoryStore)
};

// Standard limiter: 100 requests per 15 minutes
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore(),
  message: {
    status: 429,
    message: 'Too many requests, please try again later.',
  },
});

// Stricter limiter for auth endpoints: 10 attempts per hour
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore(),
  message: {
    status: 429,
    message: 'Too many login attempts. Please try again in an hour.',
  },
});
