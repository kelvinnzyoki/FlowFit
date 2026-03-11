// Cache bust - express import fix - 2026-02-24 v6
import express, { Application, Request, Response } from 'express';
import 'dotenv/config';
import { rateLimit } from 'express-rate-limit';
import cors from 'cors';
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
const app: Application = express();  // ← no .default(), no namespace


app.set('trust proxy', 1);


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



app.use(
  cors({
    origin:         process.env.CORS_ORIGIN || '*',
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
// HTML PAGE REDIRECTS → GitHub Pages
// ============================================
// Stripe's success/cancel URLs sometimes point directly at this API server
// (e.g. fit.cctamcc.site/subscription.html) because old Stripe sessions were
// created before the checkout-success redirect route existed, or because
// FRONTEND_URL env var is missing. This catches ALL such requests and sends
// the browser to the correct GitHub Pages frontend, preserving all query params.
// This handles every .html request that reaches the API server.

const FRONTEND = (process.env.FRONTEND_URL || 'https://flowfit.cctamcc.site').replace(/\/$/, '');

app.get('/*.html', (req: Request, res: Response) => {
  const destination = `${FRONTEND}${req.path}${req.search || (Object.keys(req.query).length ? '?' + new URLSearchParams(req.query as any).toString() : '')}`;
  res.redirect(302, destination);
});

// Also handle bare /subscription (without .html extension) just in case
app.get('/subscription', (req: Request, res: Response) => {
  const qs = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query as any).toString() : '';
  res.redirect(302, `${FRONTEND}/subscription.html${qs}`);
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
// Only runs when executed directly (not on Vercel).
// On Vercel the exported `app` below is used as a serverless function.
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
// SERVERLESS EXPORT
// Vercel imports this file as a module and calls the exported app
// as a serverless function for every incoming request.
// ============================================

export default app;
