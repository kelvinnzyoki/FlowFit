// Cache bust - express import fix - 2026-02-24 v6
import express, { Application, Request, Response } from 'express';
import 'dotenv/config';
import { rateLimit } from 'express-rate-limit';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import {
  contentSecurityPolicy,
  crossOriginEmbedderPolicy,
} from 'helmet';

import compression from 'compression';
import morgan from 'morgan';
import logger, { morganStream } from './utils/logger.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { standardLimiter } from './middleware/rateLimiter.js';
import prisma from './config/db.js';
import redis from './config/redis.js';

// ── Route modules ─────────────────────────────────────────────────────────────
import subscriptionRoutes from './routes/subscription.routes.js';
import stripeWebhookRoutes from './routes/webhook.routes.js';
import mpesaWebhookRoutes  from './routes/mpesa.webhook.routes.js';
import cronRoutes           from './routes/cron.routes.js';

// ============================================
// CREATE EXPRESS APP
// ============================================
const app: Application = express();

app.set('trust proxy', 1);

// ============================================
// WEBHOOKS — raw body, registered BEFORE express.json()
// ============================================

// Stripe: requires raw Buffer body for signature verification
app.use(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  stripeWebhookRoutes,
);

// M-Pesa: Daraja sends JSON — no raw body needed, but parse before json middleware
// to keep it isolated from other middleware
app.use('/api/webhooks/mpesa', express.json(), mpesaWebhookRoutes);

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

// ── CORS ──────────────────────────────────────────────────────────────────────
// credentials:true requires explicit origin (not '*')
const allowedOrigins = (process.env.CORS_ORIGIN || 'https://flowfit.cctamcc.site')
  .split(',')
  .map(o => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);  // Postman, curl
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials:    true,
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ============================================
// GENERAL MIDDLEWARE
// ============================================
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: morganStream }));
}

app.use('/api', standardLimiter);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (_req: Request, res: Response) => {
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
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString(), error: 'Service unavailable' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.json({ name: 'FlowFit API', version: '1.0.0', health: '/health' });
});

// ============================================
// API ROUTES
// ============================================
app.use('/api/v1', routes);

// Cron job endpoints (secured by CRON_SECRET)
app.use('/api/v1/internal/cron', cronRoutes);

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
    logger.info(`📱 M-Pesa webhook: http://localhost:${PORT}/api/webhooks/mpesa/callback`);
  });

  const gracefulShutdown = async (signal: string) => {
    logger.info(`\n${signal} received. Starting graceful shutdown...`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
        if (redis) await redis.quit();
        logger.info('✅ Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    });
    setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

// ============================================
// SERVERLESS EXPORT (Vercel)
// ============================================
export default app;
