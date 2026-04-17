import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'change_me_access';

export interface AuthenticatedUser {
  id:    string;
  name:  string | null;
  email: string;
  role:  string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      activeSubscription?: {
        id:                  string;
        status:              string;
        interval:            string;
        plan: {
          id:                    string;
          slug:                  string;
          name:                  string;
          description:           string | null;
          monthlyPriceCents:     number;
          yearlyPriceCents:      number;
          trialDays:             number;
          maxWorkoutsPerMonth:   number | null;
          maxPrograms:           number | null;
          hasAdvancedAnalytics:  boolean;
          hasPersonalCoaching:   boolean;
          hasNutritionTracking:  boolean;
          hasOfflineAccess:      boolean;
          features:              string[];
          displayOrder:          number;
          isPopular:             boolean;
        };
        trialEndsAt:           string | null;
        currentPeriodStart:    string | null;
        currentPeriodEnd:      string | null;
        cancelAtPeriodEnd:     boolean;
        cancelledAt:           string | null;
        scheduledPlanSlug:     string | null;
        activatedAt:           string | null;
        daysUntilRenewal:      number | null;
      };
    }
  }
}

export type AuthRequest = Request;

export const authenticate: RequestHandler = async (req, res, next) => {
  try {
    // Cookie-first (ff_refresh is the httpOnly cookie); fall back to Bearer for API tools
    const cookieToken  = req.cookies?.ff_refresh as string | undefined;
    const headerToken  = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;

    const token = cookieToken || headerToken;

    if (!token) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    const decoded = jwt.verify(token, JWT_ACCESS_SECRET) as { userId: string };

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};

export const requireAuth = authenticate;
