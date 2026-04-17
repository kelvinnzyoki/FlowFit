import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis.js';

type RedisReply = string | number | (string | number)[];

const buildStore = () => {
  if (redis) {
    return new RedisStore({
      sendCommand: async (...args: string[]): Promise<RedisReply> => {
        const result = await (redis!.call as (...args: string[]) => Promise<any>)(...args);
        return result as RedisReply;
      },
    });
  }
  console.warn('Rate limiter: Redis unavailable, falling back to in-memory store. Limits will not be shared across instances.');
  return undefined;
};

export const standardLimiter = rateLimit({
  windowMs:      15 * 60 * 1000,
  max:           5000,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:          (req) => req.method === 'OPTIONS',
  store:         buildStore(),
  message:       { status: 429, message: 'Too many requests, please try again later.' },
});

export const authLimiter = rateLimit({
  windowMs:             60 * 60 * 1000,
  max:                  1000,
  standardHeaders:      true,
  legacyHeaders:        false,
  skipSuccessfulRequests: true,
  skip:                 (req) => req.method === 'OPTIONS',
  keyGenerator:         (req) => `auth:${req.ip}-${req.body?.email ?? 'unknown'}`,
  store:                buildStore(),
  message:              { status: 429, message: 'Too many login attempts. Please try again in an hour.' },
});
