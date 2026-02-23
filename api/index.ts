// api/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function entry point.
// Vercel imports this file directly — the exported Express app handles
// every incoming request without calling app.listen().
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

// Middleware
import { errorHandler, notFoundHandler } from '../src/middleware/error.middleware.js';
import { standardLimiter } from '../src/middleware/rateLimiter.js';

// Routes
import routes from '../src/routes/index.js';

// Config
import prisma from '../src/config/db.js';
import redis from '../src/config/redis.js';

const app: Application = express();

// ─── Security ────────────────────────────────────────────────────────────────

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
    crossOriginEmbedderPolicy: false,
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

// ─── General Middleware ──────────────────────────────────────────────────────

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

// Rate limiting on all /api routes
app.use('/api', standardLimiter);

// ─── Health Check ────────────────────────────────────────────────────────────

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

// ─── Root ────────────────────────────────────────────────────────────────────

app.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    name:        'FlowFit API',
    version:     '1.0.0',
    status:      'running',
    health:      '/health',
    api:         '/api/v1',
  });
});

// ─── API Routes ──────────────────────────────────────────────────────────────

app.use('/api/v1', routes);

// ─── Error Handling ──────────────────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Export for Vercel ───────────────────────────────────────────────────────
// Vercel calls this exported handler for every request.
// Never call app.listen() here — Vercel manages the server lifecycle.

export default app;
