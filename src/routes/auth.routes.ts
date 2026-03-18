import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

const JWT_ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'change_me_access';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change_me_refresh';
const ACCESS_EXPIRES     = '15m';
const REFRESH_EXPIRES    = '7d';

// ── Cookie configuration ────────────────────────────────────────────────────
//
// SameSite=None + Secure is REQUIRED for cross-origin cookies:
//   Frontend: https://flowfit.cctamcc.site  (GitHub Pages)
//   Backend:  https://fit.cctamcc.site      (Vercel)
//
// In local dev (NODE_ENV !== 'production') we relax to SameSite=Lax / Secure=false
// so the cookies work over http://localhost.
//
const isProd = process.env.NODE_ENV === 'production';

const ACCESS_COOKIE_OPTS = {
  httpOnly: true,
  secure:   isProd,
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  path:     '/',
  maxAge:   15 * 60 * 1000,           // 15 minutes in ms
};

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure:   isProd,
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  path:     '/',
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// Cookie names — prefixed to avoid collision with other apps on the same domain
const ACCESS_COOKIE  = 'ff_access';
const REFRESH_COOKIE = 'ff_refresh';

// ── Token helpers ───────────────────────────────────────────────────────────
function generateTokens(userId: string) {
  const accessToken  = jwt.sign({ userId }, JWT_ACCESS_SECRET,  { expiresIn: ACCESS_EXPIRES });
  const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
  return { accessToken, refreshToken };
}

async function storeRefreshToken(userId: string, token: string) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });
}

async function deleteRefreshToken(token: string) {
  await prisma.refreshToken.deleteMany({ where: { token } });
}

async function deleteAllRefreshTokens(userId: string) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

/** Set both auth cookies on the response */
function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE,  accessToken,  ACCESS_COOKIE_OPTS);
  res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS);
}

/** Clear both auth cookies */
function clearAuthCookies(res: Response) {
  // Must match the original options (path, domain, sameSite, secure) for the
  // browser to actually delete the cookie.
  res.clearCookie(ACCESS_COOKIE,  { ...ACCESS_COOKIE_OPTS,  maxAge: 0 });
  res.clearCookie(REFRESH_COOKIE, { ...REFRESH_COOKIE_OPTS, maxAge: 0 });
}

// ─── POST /api/v1/auth/register ─────────────────────────────────────────────
router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ success: false, error: 'Name, email and password are required.' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ success: false, error: 'An account with that email already exists.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: { name, email, password: hashedPassword },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      });
      await tx.profile.create({ data: { userId: newUser.id } });
      return newUser;
    });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await storeRefreshToken(user.id, refreshToken);

    // Set tokens as HTTP-only cookies — never exposed to JS
    setAuthCookies(res, accessToken, refreshToken);

    // Return user data only — no tokens in the body
    res.status(201).json({ success: true, data: { user } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

// ─── POST /api/v1/auth/login ────────────────────────────────────────────────
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and password are required.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data:  { lastLogin: new Date() },
    });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await storeRefreshToken(user.id, refreshToken);

    const { password: _, ...safeUser } = user;

    // Set tokens as HTTP-only cookies — never exposed to JS
    setAuthCookies(res, accessToken, refreshToken);

    // Return user data only — no tokens in the body
    res.status(200).json({ success: true, data: { user: safeUser } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/v1/auth/logout ───────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  try {
    // Read the refresh token from cookie (preferred) or body (legacy fallback)
    const refreshToken: string | undefined =
      (req as any).cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;

    if (refreshToken) {
      await deleteRefreshToken(refreshToken);
    }

    clearAuthCookies(res);
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  } catch {
    // Clear cookies regardless of DB errors so the client is always logged out
    clearAuthCookies(res);
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  }
});

// ─── POST /api/v1/auth/refresh ──────────────────────────────────────────────
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    // Read refresh token from cookie (preferred) or body (legacy fallback)
    const refreshToken: string | undefined =
      (req as any).cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;

    if (!refreshToken) {
      res.status(400).json({ success: false, error: 'Refresh token required.' });
      return;
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: string };

    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
      clearAuthCookies(res);
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      clearAuthCookies(res);
      res.status(401).json({ success: false, error: 'User not found.' });
      return;
    }

    // Rotate: delete old token, issue fresh pair
    await deleteRefreshToken(refreshToken);
    const tokens = generateTokens(user.id);
    await storeRefreshToken(user.id, tokens.refreshToken);

    // Set new cookies — no tokens in the response body
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    res.status(200).json({ success: true, data: { user } });
  } catch {
    clearAuthCookies(res);
    res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
  }
});

// ─── GET /api/v1/auth/me ────────────────────────────────────────────────────
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: {
        id: true, name: true, email: true, role: true,
        isEmailVerified: true, lastLogin: true, createdAt: true,
        profile: true,
      },
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    res.status(200).json({ success: true, data: user });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user.' });
  }
});

// ─── POST /api/v1/auth/change-password ──────────────────────────────────────
router.post('/change-password', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, error: 'Both current and new password are required.' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ success: false, error: 'New password must be at least 8 characters.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    const passwordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatch) {
      res.status(401).json({ success: false, error: 'Current password is incorrect.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } }),
      // Invalidate ALL sessions after a password change
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    // Force re-login by clearing cookies
    clearAuthCookies(res);

    res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Failed to change password.' });
  }
});

export default router;
