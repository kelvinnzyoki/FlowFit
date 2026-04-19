import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'change_me_access';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change_me_refresh';

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
    const cookieToken = req.cookies?.ff_refresh as string | undefined;
    const headerToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;

    let tokenToVerify = '';
    let secretToUse = '';

    // 1. PRIORITY: Main SaaS uses the Bearer Access Token
    if (headerToken) {
      tokenToVerify = headerToken;
      secretToUse = process.env.JWT_ACCESS_SECRET || 'change_me_access';
    } 
    // 2. FALLBACK: AI Coach uses the Refresh Cookie
    else if (cookieToken) {
      tokenToVerify = cookieToken;
      secretToUse = process.env.JWT_REFRESH_SECRET || 'change_me_refresh';
    } 
    // 3. REJECT: No tokens provided
    else {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    // Verify using the dynamically selected secret
    const decoded = jwt.verify(tokenToVerify, secretToUse) as { userId: string };

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
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};


export const requireAuth = authenticate;
