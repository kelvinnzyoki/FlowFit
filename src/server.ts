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
import subscriptionRoutes from './routes/subscription.routes.js';
import webhookRoutes from './routes/webhook.routes.js';

// ============================================
// CREATE EXPRESS APP
// ============================================
const app: Application = express();

app.set('trust proxy', 1);

// ============================================
// WEBHOOKS — must be raw body, registered FIRST
// ============================================
app.use(
  '/api/webhooks/stripe',
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

// ── CORS ────────────────────────────────────────────────────────────────────
// credentials:true REQUIRES an explicit origin — the wildcard '*' is rejected
// by browsers when credentials (cookies) are included.
//
// Set CORS_ORIGIN in your Vercel environment variables:
//   Production:  https://flowfit.cctamcc.site
//   Development: http://localhost:5500  (or whatever your local port is)
//
const allowedOrigins = (process.env.CORS_ORIGIN || 'https://flowfit.cctamcc.site')
  .split(',')
  .map(o => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials:    true,                                        // ← required for cookies
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

// ── Cookie parser — must be before any route that reads req.cookies ─────────
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

// Root route
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
        logger.info('✅ Graceful shutdown completed');
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
// SERVERLESS EXPORT (Vercel)
// ============================================
export default app;
