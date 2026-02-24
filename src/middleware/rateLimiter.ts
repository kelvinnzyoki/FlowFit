import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis.js';

// Define a type for the Redis reply to satisfy the library's expectations
type RedisReply = string | number | (string | number)[];

/**
 * Builds a Redis-backed store for express-rate-limit.
 * Uses a type-safe wrapper for the ioredis 'call' method to resolve
 * spread argument (TS2556) and return type (TS2322) errors.
 */
const buildStore = () => {
  if (redis) {
    return new RedisStore({
      sendCommand: async (...args: string[]): Promise<RedisReply> => {
        // FIXED: Added the ! operator after 'redis' to satisfy the null check inside the callback
        const result = await (redis!.call as (...args: string[]) => Promise<any>)(...args);
        return result as RedisReply;
      },
    });
  }

  console.warn(
    'Rate limiter: Redis unavailable, falling back to in-memory store. ' +
    'Rate limits will NOT be shared across serverless instances.'
  );
  return undefined; // Falls back to MemoryStore
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
