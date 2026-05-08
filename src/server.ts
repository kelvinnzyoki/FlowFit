// FLOWFIT — server.ts (Paystack raw-webhook safe)
import express, { Application, Request, Response } from 'express';
import 'dotenv/config';
import cors from 'cors';
import { contentSecurityPolicy } from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import logger, { morganStream } from './utils/logger.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { standardLimiter } from './middleware/rateLimiter.js';
import prisma from './config/db.js';
import redis from './config/redis.js';

import subscriptionRoutes from './routes/subscription.routes.js';
import paystackWebhookRoutes from './routes/paystack.webhook.routes.js';
import exerciseRoutes from './routes/exercise.routes.js';
import aiRoutes from './routes/ai.routes.js';
import notificationRoutes from './routes/notification.routes.js';
//import adminRoutes from './routes/admin.routes.js';

const app: Application = express();

app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// PAYSTACK WEBHOOKS MUST BE MOUNTED BEFORE express.json()
// -----------------------------------------------------------------------------
// Paystack signs the exact raw JSON bytes. If express.json() runs first, valid
// subscription.create events can fail signature verification and the DB will
// never receive subscription_code/email_token.
//
// Keep both paths for backward compatibility:
// - /api/webhooks/paystack       old dashboard URL used by many deployments
// - /api/v1/paystack/webhook     canonical v1 API URL used by corrected files
// Configure Paystack dashboard to one of these exact URLs.
const paystackRawJson = express.raw({ type: 'application/json', limit: '2mb' });
app.use('/api/webhooks/paystack', paystackRawJson, paystackWebhookRoutes);
app.use('/api/v1/webhooks/paystack', paystackRawJson, paystackWebhookRoutes);

// -----------------------------------------------------------------------------
// SECURITY MIDDLEWARE
// -----------------------------------------------------------------------------
app.use(
  contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  }),
);

const RAW_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set<string>(
  RAW_ORIGINS.length > 0
    ? RAW_ORIGINS
    : ['http://localhost:3000', 'http://localhost:5173'],
);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// -----------------------------------------------------------------------------
// GENERAL MIDDLEWARE — safe to parse JSON only after raw webhook mounts above
// -----------------------------------------------------------------------------
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

// Prevent Vercel/CDN/browser caching of authenticated API responses.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Vary', 'Authorization, Cookie');
  next();
});

// -----------------------------------------------------------------------------
// HEALTH CHECKS
// -----------------------------------------------------------------------------
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    let redisStatus = 'disabled';
    if (redis) {
      await redis.ping();
      redisStatus = 'connected';
    }

    return res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      database: 'connected',
      redis: redisStatus,
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    return res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Service unavailable',
    });
  }
});

app.get('/', (_req: Request, res: Response) => {
  return res.json({
    name: 'FlowFit API',
    version: '1.0.0',
    description: 'Production-ready fitness tracking SaaS backend',
    documentation: '/api/docs',
    health: '/health',
  });
});

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------
app.use('/api/exercises', exerciseRoutes);
app.use('/api/v1', routes);

// Explicit route groups. Keep these even if routes/index also mounts some of
// them; Express stops at the first handler that sends a response.
app.use('/api/v1/subscriptions', subscriptionRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/notifications', notificationRoutes);
//app.use('/api/v1/admin', adminRoutes);

// -----------------------------------------------------------------------------
// ERROR HANDLING
// -----------------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

// -----------------------------------------------------------------------------
// LOCAL DEV SERVER
// -----------------------------------------------------------------------------
const isVercel = process.env.VERCEL === '1';

if (!isVercel) {
  const PORT = Number(process.env.PORT || 3000);

  const server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on PORT ${PORT}`);
    logger.info(`📦 Environment: ${process.env.NODE_ENV}`);
    logger.info(`🔗 API: http://localhost:${PORT}/api/v1`);
    logger.info(`💚 Health: http://localhost:${PORT}/health`);
  });

  const gracefulShutdown = async (signal: string) => {
    logger.info(`${signal} received. Starting graceful shutdown...`);

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
    }, 10000).unref();
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}

export default app;
