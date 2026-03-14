import { rateLimit, Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis.js';

type RedisReply = string | number | (string | number)[];

// ── Dev bypass ────────────────────────────────────────────────────────────────
// Set DEV_BYPASS_SECRET in your local .env (never in Vercel prod env vars).
// Pass it as header: X-Dev-Bypass: <secret>
// Alternatively, all requests from localhost are skipped automatically.
const DEV_BYPASS_SECRET = process.env.DEV_BYPASS_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';

const shouldSkip = (req: any): boolean => {
  // Never bypass in production regardless of header
  if (IS_PROD) return false;

  // Skip for localhost (your local dev server or browser)
  const ip = req.ip ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')) return true;

  // Skip if the secret header matches
  if (DEV_BYPASS_SECRET && req.headers['x-dev-bypass'] === DEV_BYPASS_SECRET) return true;

  return false;
};

// ── Store ─────────────────────────────────────────────────────────────────────
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

// ── Standard limiter: 300 req / 15 min ───────────────────────────────────────
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldSkip,
  store: buildStore(),
  message: {
    status: 429,
    message: 'Too many requests, please try again later.',
  },
});

// ── Auth limiter: 10 failed attempts / hour ───────────────────────────────────
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: (req) => req.method === 'OPTIONS' || shouldSkip(req),
  keyGenerator: (req) => {
    const email = req.body?.email ?? 'unknown';
    return `auth:${req.ip}-${email}`;
  },
  store: buildStore(),
  message: {
    status: 429,
    message: 'Too many login attempts. Please try again in an hour.',
  },
});
