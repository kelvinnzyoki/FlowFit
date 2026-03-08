import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'change_me_access';

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: string;
}


// ── 2. Global augmentation references AuthenticatedUser — not an inline object
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;   // ← same named type, not a separate inline definition
    }
  }
}


import { RequestHandler } from 'express';

// FIXED — typed as standard RequestHandler, casts internally
export const authenticate: RequestHandler = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      res.status(401).json({ success: false, error: 'No token provided.' });
      return;
    }
    const decoded = jwt.verify(token, JWT_ACCESS_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },  // name must be here
    });
    if (!user) {
      res.status(401).json({ success: false, error: 'User not found.' });
      return;
    }
    req.user = user;// works because of the global Express augmentation above
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};


export const requireAuth = authenticate;
