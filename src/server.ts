import 'dotenv/config';
import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet/index.mjs';
import compression from 'compression';
import morgan from 'morgan';
import logger, { morganStream } from './utils/logger.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { standardLimiter } from './middleware/rateLimiter.js';
import prisma from './config/db.js';
import redis from './config/redis.js';

// ============================================
// CREATE EXPRESS APP
// ============================================

const app: Application = express();

// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        scriptSrc:  ["'self'"],
        imgSrc:     ["'self'", 'data:', 'https:'],
      },
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
