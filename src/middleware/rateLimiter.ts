import { type Request } from 'express';
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

const getClientIp = (req: Request): string => {
  const forwardedFor = req.headers['x-forwarded-for'];
  return (
    req.ip ||
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0]?.trim()) ||
    'unknown'
  );
};

export const standardLimiter = rateLimit({
  windowMs:      15 * 60 * 1000,
  max:           5000,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:          (req: Request) => req.method === 'OPTIONS',
  store:         buildStore(),
  message:       { status: 429, message: 'Too many requests, please try again later.' },
});

export const authLimiter = rateLimit({
  windowMs:             60 * 60 * 1000,
  max:                  20,
  standardHeaders:      true,
  legacyHeaders:        false,
  skipSuccessfulRequests: true,
  skip:                 (req: Request) => req.method === 'OPTIONS',
  keyGenerator:         (req: Request) => `auth:${getClientIp(req)}-${String(req.body?.email ?? 'unknown').toLowerCase()}`,
  store:                buildStore(),
  message:              { status: 429, message: 'Too many login attempts. Please try again in an hour.' },
});
