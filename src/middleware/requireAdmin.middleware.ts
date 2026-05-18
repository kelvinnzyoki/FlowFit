import { Response, NextFunction, RequestHandler } from 'express';
import { AuthRequest, authenticate } from './auth.middleware.js';

export const requireAdmin: RequestHandler = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({
      success: false,
      error: 'Admin access required.',
    });
    return;
  }

  next();
};

export const authenticateAdmin: RequestHandler[] = [authenticate, requireAdmin];
