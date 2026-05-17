import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  
  // Log the error for the admin (you) to see in Vercel logs
  logger.error(`${err.message} - ${req.method} ${req.originalUrl} - IP: ${req.ip}`);

  const isProduction = process.env.NODE_ENV === 'production';

  res.status(statusCode).json({
    status: 'error',
    message: isProduction ? 'Internal server error.' : err.message,
    // Only show stack trace in development mode
    stack: isProduction ? '🥞' : err.stack,
  });
};
