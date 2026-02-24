import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis.js';

// Define a type that matches the expected Redis reply for the store
type RedisReply = string | number | (string | number)[];

const buildStore = () => {
  // FIXED: Check if redis exists and handle type casting for sendCommand
  if (redis) {
    return new RedisStore({
      sendCommand: async (...args: string[]): Promise<RedisReply> => {
        // We use 'as any' to bypass the complex ioredis/rate-limit-redis type mismatch
        // but cast the final result to Promise<RedisReply>
        return (await redis!.call(...args)) as RedisReply;
      },
    });
  }

  console.warn(
    'Rate limiter: Redis unavailable, falling back to in-memory store. ' +
    'Rate limits will NOT be shared across serverless instances.'
  );
  return undefined; 
};

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
