import 'dotenv/config';
import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import logger, { morganStream } from './utils/logger.js';
import routes from './routes/index.js';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error.middleware.js';
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

// Helmet - Secure HTTP headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// CORS - Cross-Origin Resource Sharing
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ============================================
// GENERAL MIDDLEWARE
// ============================================

// Compression - Compress responses
app.use(compression());

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logger
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: morganStream }));
}

// Rate limiting
app.use('/api', standardLimiter);

// ============================================
// HEALTH CHECK
// ============================================

// FIX 1: Added explicit Request, Response types to eliminate implicit 'any' errors
app.get('/health', async (req: Request, res: Response) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;

    // FIX 2: redis can be null (getRedisClient() returns null when REDIS_URL is missing).
    // Guard with a conditional so we don't call .ping() on null.
    let redisStatus = 'disabled';
    if (redis) {
      await redis.ping();
      redisStatus = 'connected';
    }

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      database: 'connected',
      redis: redisStatus,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Service unavailable',
    });
  }
});

// FIX 3: Added explicit Request, Response types here too
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'FlowFit API',
    version: '1.0.0',
    description: 'Production-ready fitness tracking SaaS backend',
    documentation: '/api/docs',
    health: '/health',
  });
});

// ============================================
// API ROUTES
// ============================================

app.use('/api', routes);

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler - must be after all routes
app.use(notFoundHandler);

// Global error handler - must be last
app.use(errorHandler);

// ============================================
// SERVER STARTUP
// ============================================

const startServer = async () => {
  try {
    // FIX 4: Vercel is serverless — it manages the port itself.
    // For local dev, fall back to 3000 so process.listen() always gets a valid value.
    const PORT = process.env.PORT || 3000;

    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on PORT ${PORT}`);
      logger.info(`📦 Environment: ${process.env.NODE_ENV}`);
      logger.info(`🔗 API: http://localhost:${PORT}/api`);
      logger.info(`💚 Health: http://localhost:${PORT}/health`);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`\n${signal} received. Starting graceful shutdown...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await prisma.$disconnect();
          logger.info('Database connection closed');

          // FIX 5: Guard redis before calling .quit() — same null-safety fix as above
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

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer();

export default app;
