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

// Extend Express Request globally so every route gets req.user without casting
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

// AuthRequest is just Request — user is injected via the global augmentation above
export type AuthRequest = Request;

/**
 * authenticate middleware
 *
 * Token source priority:
 *   1. HTTP-only cookie  `ff_access`  (browser clients after cookie migration)
 *   2. Authorization: Bearer <token>   (API tools, Stripe webhooks, legacy clients)
 *
 * This dual-source approach means the migration is zero-downtime:
 * old clients sending Authorization headers keep working while new clients
 * use cookies.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  try {
    // 1. Prefer the HTTP-only cookie
    const cookieToken = (req as any).cookies?.ff_access as string | undefined;
    // 2. Fall back to Authorization header
    const headerToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;

    const token = cookieToken || headerToken;

    if (!token) {
      res.status(401).json({ success: false, error: 'No token provided.' });
      return;
    }

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

export const requireAuth = authenticate;
