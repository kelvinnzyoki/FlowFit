import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'change_me_access';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'No token provided.' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_ACCESS_SECRET) as { userId: string };

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      res.status(401).json({ success: false, error: 'User not found.' });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};
