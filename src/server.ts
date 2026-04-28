// Cache bust - express import fix - 2026-02-24 v6
import express, { Application, Request, Response } from 'express';
import 'dotenv/config';
import { rateLimit } from 'express-rate-limit';
import cors from 'cors';
import { contentSecurityPolicy } from 'helmet';

import compression from 'compression';
import morgan from 'morgan';
import logger, { morganStream } from './utils/logger.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { standardLimiter } from './middleware/rateLimiter.js';
import prisma from './config/db.js';
import redis from './config/redis.js';
import subscriptionRoutes from './routes/subscription.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import exerciseRoutes from "./routes/exercise.routes.js";
import cookieParser from 'cookie-parser';
import aiRoutes from './routes/ai.routes.js';
import notificationRoutes from './routes/notification.routes.js';

// ============================================
// CREATE EXPRESS APP
// ============================================
const app: Application = express();  // <- no .default(), no namespace

app.set('trust proxy', 1);

// ── Webhook routes — registered with express.raw() BEFORE the global
// express.json() middleware so the raw body buffer is preserved for
// HMAC signature verification in each handler.
//
// Paystack: signs each webhook by computing HMAC-SHA512 over the raw request
//   body using PAYSTACK_SECRET_KEY, and sends the hex digest in the
//   x-paystack-signature header. The handler must verify this against the
//   raw Buffer — parsing to JSON first would break the comparison.
//
// M-Pesa:   similarly delivers a raw JSON body that must be read as a Buffer
//   before the handler can safely parse and trust it.

app.use(
  '/api/webhooks/paystack',
  express.raw({ type: 'application/json' }),
  webhookRoutes,
);

app.use(
  '/api/webhooks/mpesa/callback',
  express.raw({ type: 'application/json' }),
  webhookRoutes,
);

// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(
  contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      scriptSrc:  ["'self'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
    },
  })
);

// ── Allowed origins ────────────────────────────────────────────────────────────
const RAW_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
const ALLOWED_ORIGINS: Set<string> = new Set(
  RAW_ORIGINS.length > 0
    ? RAW_ORIGINS
    : ['http://localhost:3000', 'http://localhost:5173']
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials:    true,
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge:         86400,
  })
);

app.options('*', cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// ============================================
// GENERAL MIDDLEWARE
// ============================================

app.use(cookieParser());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: morganStream }));
}

app.use('/api', standardLimiter);

// CRITICAL: Prevent Vercel/CDN from caching any authenticated API response.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use('/api', (_req, res, next) => {
  res.setHeader('Vary', 'Authorization, Cookie');
  next();
});

app.use('/api/exercises', exerciseRoutes);

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    let redisStatus = 'disabled';
    if (redis) {
      await redis.ping();
      redisStatus = 'connected';
    }

    res.status(200).json({
      status:      'healthy',
      timestamp:   new Date().toISOString(),
      uptime:      process.uptime(),
      environment: process.env.NODE_ENV,
      database:    'connected',
      redis:       redisStatus,
    });
  } catch {
    res.status(503).json({
      status:    'unhealthy',
      timestamp: new Date().toISOString(),
      error:     'Service unavailable',
    });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.json({
    name:          'FlowFit API',
    version:       '1.0.0',
    description:   'Production-ready fitness tracking SaaS backend',
    documentation: '/api/docs',
    health:        '/health',
  });
});

// ============================================
// API ROUTES
// ============================================

app.use('/api/v1', routes);

app.use('/api/v1/ai',            aiRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// ============================================
// ERROR HANDLING
// ============================================

app.use(notFoundHandler);
app.use(errorHandler);

// ============================================
// LOCAL DEV SERVER
// ============================================

const isVercel = process.env.VERCEL === '1';

if (!isVercel) {
  const PORT = process.env.PORT || 3000;

  const server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on PORT ${PORT}`);
    logger.info(`📦 Environment: ${process.env.NODE_ENV}`);
    logger.info(`🔗 API: http://localhost:${PORT}/api/v1`);
    logger.info(`💚 Health: http://localhost:${PORT}/health`);
  });

  const gracefulShutdown = async (signal: string) => {
    logger.info(`\n${signal} received. Starting graceful shutdown...`);

    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await prisma.$disconnect();
        logger.info('Database connection closed');

        if (redis) {
          await redis.quit();
          logger.info('Redis connection closed');
        }

        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

// ============================================
// SERVERLESS EXPORT
// ============================================

export default app;
