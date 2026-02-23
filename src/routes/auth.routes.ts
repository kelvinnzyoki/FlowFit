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

function generateTokens(userId: string) {
  const accessToken  = jwt.sign({ userId }, JWT_ACCESS_SECRET,  { expiresIn: ACCESS_EXPIRES });
  const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
  return { accessToken, refreshToken };
}

// Store refresh token in DB using the RefreshToken model from the schema
async function storeRefreshToken(userId: string, token: string) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({
    data: { token, userId, expiresAt },
  });
}

// Delete one specific refresh token (logout) or all for a user (password change)
async function deleteRefreshToken(token: string) {
  await prisma.refreshToken.deleteMany({ where: { token } });
}

async function deleteAllRefreshTokens(userId: string) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

// ─── POST /api/v1/auth/register ─────────────────────────────────────────────
// Called by: AuthAPI.register() → register.html
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

    // Create user + empty Profile in a transaction so both always exist together
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

    res.status(201).json({
      success: true,
      data: { user, accessToken, refreshToken },
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

// ─── POST /api/v1/auth/login ────────────────────────────────────────────────
// Called by: AuthAPI.login() → login.html
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

    // Update lastLogin timestamp
    await prisma.user.update({
      where: { id: user.id },
      data:  { lastLogin: new Date() },
    });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await storeRefreshToken(user.id, refreshToken);

    const { password: _, ...safeUser } = user;

    res.status(200).json({
      success: true,
      data: { user: safeUser, accessToken, refreshToken },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/v1/auth/logout ───────────────────────────────────────────────
// Called by: AuthAPI.logout() — sends { refreshToken } in body
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await deleteRefreshToken(refreshToken);
    }
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  } catch {
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  }
});

// ─── POST /api/v1/auth/refresh ──────────────────────────────────────────────
// Called by: refreshAccessToken() in api.js — auto token refresh on 401
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ success: false, error: 'Refresh token required.' });
      return;
    }

    // Verify signature first
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: string };

    // Then check it actually exists in DB and hasn't expired
    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      res.status(401).json({ success: false, error: 'User not found.' });
      return;
    }

    // Rotate: delete old token, issue new pair
    await deleteRefreshToken(refreshToken);
    const tokens = generateTokens(user.id);
    await storeRefreshToken(user.id, tokens.refreshToken);

    res.status(200).json({
      success: true,
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    });
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
  }
});

// ─── GET /api/v1/auth/me ────────────────────────────────────────────────────
// Called by: AuthAPI.getCurrentUser() → checkAuth() in api.js
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: {
        id:              true,
        name:            true,
        email:           true,
        role:            true,
        isEmailVerified: true,
        lastLogin:       true,
        createdAt:       true,
        profile:         true,
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
// Called by: AuthAPI.changePassword()
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
      // Invalidate ALL existing sessions after a password change
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    res.status(200).json({ success: true, message: 'Password changed successfully. Please log in again.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Failed to change password.' });
  }
});

export default router;
