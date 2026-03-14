import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis.js';

type RedisReply = string | number | (string | number)[];

/**
 * Lazily build a Redis-backed store so it's evaluated after Redis has
 * had a chance to connect, not at cold-start import time.
 */
const buildStore = () => {
  if (redis) {
    return new RedisStore({
      sendCommand: async (...args: string[]): Promise<RedisReply> => {
        const result = await (redis!.call as (...args: string[]) => Promise<any>)(...args);
        return result as RedisReply;
      },
    });
  }
  console.warn(
    'Rate limiter: Redis unavailable, falling back to in-memory store. ' +
    'Rate limits will NOT be shared across serverless instances.'
  );
  return undefined;
};

/**
 * Standard limiter for general API endpoints.
 * 300 req / 15 min — generous enough for a SPA that fires 10–15 calls
 * per page load across dashboard, workouts, progress, subscription, etc.
 */
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore(),
  message: {
    status: 429,
    message: 'Too many requests, please try again later.',
  },
});

/**
 * Auth limiter for login / register endpoints only.
 * 10 attempts per hour per IP+email.
 * Only failed attempts count toward the limit.
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,   // FIX: successful logins don't burn quota
  skip: (req) => req.method === 'OPTIONS',
  keyGenerator: (req) => {
    // FIX: guard against body not yet parsed or missing email field
    const email = req.body?.email ?? 'unknown';
    return `auth:${req.ip}-${email}`;
  },
  store: buildStore(),
  message: {
    status: 429,
    message: 'Too many login attempts. Please try again in an hour.',
  },
});
