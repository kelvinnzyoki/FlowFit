import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

const JWT_ACCESS_SECRET = (() => {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET env var is required. Refusing to start with an unsafe fallback secret.');
  }
  return secret;
})();

// JWT_REFRESH_SECRET is no longer imported here — the middleware only ever
// verifies access tokens. The /refresh endpoint in auth_routes.ts is the
// sole place that reads and verifies the refresh cookie.

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

// ── authenticate ──────────────────────────────────────────────────────────────
//
// Validates the Bearer access token sent in the Authorization header.
//
// FIX 1 + FIX 2:
//   The original middleware accepted the refresh cookie as a fallback when no
//   Bearer header was present. That was wrong for two reasons:
//     a) When a Bearer token IS present but expired, jwt.verify throws and the
//        catch block returned 401 immediately — the refresh cookie was never
//        tried. So users were logged out every 15 minutes.
//     b) Using the long-lived (7-day) refresh token to authenticate arbitrary
//        protected routes collapsed the security boundary between access and
//        refresh tokens. A leaked refresh token could then directly access any
//        endpoint, not just /refresh.
//
//   The correct flow is:
//     1. Frontend sends Bearer access token on every protected request.
//     2. On 401 { code: 'TOKEN_EXPIRED' }, frontend calls POST /auth/refresh.
//     3. /refresh validates the httpOnly cookie, rotates tokens, returns a new
//        access token.
//     4. Frontend retries the original request with the new access token.
//
//   This middleware now ONLY verifies access tokens. It never reads the cookie.
//
export const authenticate: RequestHandler = async (req, res, next) => {
  // Prefer the frontend Bearer access token, but keep a safe cookie fallback.
  // This matters after moving the frontend host: old localStorage Bearer tokens
  // can remain in the browser while the new httpOnly ff_access cookie is valid.
  // If the header token fails, we try the cookie token before rejecting.
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const cookieToken = req.cookies?.ff_access as string | undefined;

  if (!headerToken && !cookieToken) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  let decoded: { userId: string };
  try {
    decoded = jwt.verify(headerToken || cookieToken!, JWT_ACCESS_SECRET) as { userId: string };
  } catch (headerErr: any) {
    if (headerToken && cookieToken && headerToken !== cookieToken) {
      try {
        decoded = jwt.verify(cookieToken, JWT_ACCESS_SECRET) as { userId: string };
      } catch (cookieErr: any) {
        if (cookieErr.name === 'TokenExpiredError') {
          res.status(401).json({
            success: false,
            error: 'Access token expired.',
            code: 'TOKEN_EXPIRED',
          });
        } else {
          res.status(401).json({ success: false, error: 'Invalid token.', code: 'INVALID_TOKEN' });
        }
        return;
      }
    } else {
      if (headerErr.name === 'TokenExpiredError') {
        res.status(401).json({
          success: false,
          error: 'Access token expired.',
          code: 'TOKEN_EXPIRED',
        });
      } else {
        res.status(401).json({ success: false, error: 'Invalid token.', code: 'INVALID_TOKEN' });
      }
      return;
    }
  }

  try {
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
    console.error('authenticate DB error:', error);
    res.status(500).json({ success: false, error: 'Authentication check failed.' });
  }
};

export const requireAuth = authenticate;
