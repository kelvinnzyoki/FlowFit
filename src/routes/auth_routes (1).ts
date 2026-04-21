import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Resend } from 'resend';
import prisma from '../config/db.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { authenticate } from '../middleware/auth.middleware.js';
import phoneOtpRoutes from './phone.otp.routes.js';

const router = Router();

const JWT_ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'change_me_access';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change_me_refresh';
const ACCESS_EXPIRES     = '15m';
const REFRESH_EXPIRES    = '7d';
const OTP_TTL_MINUTES    = 10;
const OTP_LENGTH         = 6;

const IS_PROD = process.env.NODE_ENV === 'production';

// sameSite:'none'+secure required for cross-origin (GitHub Pages → Vercel); 'lax' for local dev
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   IS_PROD,
  sameSite: (IS_PROD ? 'none' : 'lax') as 'none' | 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000,
  domain:   IS_PROD ? '.cctamcc.site' : undefined,
  path:     '/',
};

function setRefreshCookie(res: Response, token: string) {
  res.cookie('ff_refresh', token, REFRESH_COOKIE_OPTIONS);
}

function clearRefreshCookie(res: Response) {
  res.clearCookie('ff_refresh', { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
}

function generateTokens(userId: string) {
  const accessToken  = jwt.sign({ userId }, JWT_ACCESS_SECRET,  { expiresIn: ACCESS_EXPIRES });
  const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
  return { accessToken, refreshToken };
}

// Store a SHA-256 hash of the refresh token — raw JWT never touches the DB
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function storeRefreshToken(userId: string, token: string) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await prisma.refreshToken.create({ data: { token: hashToken(token), userId, expiresAt } });
}

async function deleteRefreshToken(token: string) {
  await prisma.refreshToken.deleteMany({ where: { token: hashToken(token) } });
}

async function deleteAllRefreshTokens(userId: string) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

function generateOtp(): string {
  const max = Math.pow(10, OTP_LENGTH);
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

async function issueOtp(email: string, purpose: string): Promise<string> {
  const code      = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  const codeHash  = await bcrypt.hash(code, 10);
  await prisma.otpCode.deleteMany({ where: { email, purpose } });
  await prisma.otpCode.create({ data: { email, codeHash, purpose, expiresAt } });
  return code;
}

// FIX 4: verifyOtp no longer unconditionally marks isEmailVerified — only does so
// for the 'registration' purpose. Password-reset verification must not grant
// email-verified status to an account that never completed registration OTP.
async function verifyOtp(email: string, code: string, purpose: string): Promise<boolean> {
  const record = await prisma.otpCode.findFirst({
    where: { email, purpose, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return false;
  const match = await bcrypt.compare(code, record.codeHash);
  if (!match) return false;

  const updates: Prisma.PrismaPromise<unknown>[] = [
    prisma.otpCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ];
  if (purpose === 'registration') {
    updates.push(prisma.user.update({ where: { email }, data: { isEmailVerified: true } }));
  }
  await prisma.$transaction(updates);
  return true;
}

// ─── POST /api/v1/auth/register ──────────────────────────────────────────────
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
      // Ambiguous response — do not reveal whether the email is registered
      res.status(200).json({ success: true, message: 'If this email is new, your account has been created.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: { name, email, isEmailVerified: false, password: hashedPassword },
        select: { id: true, name: true, email: true, isEmailVerified: true, role: true, createdAt: true },
      });
      await tx.profile.create({ data: { userId: newUser.id } });
      return newUser;
    });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await storeRefreshToken(user.id, refreshToken);
    setRefreshCookie(res, refreshToken);

    res.status(201).json({ success: true, data: { user, accessToken } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

// ─── GET /api/v1/auth/check-email ────────────────────────────────────────────
router.get('/check-email', async (req: Request, res: Response) => {
  try {
    const email = (req.query.email as string)?.toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, error: 'A valid email is required.' });
      return;
    }
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    res.json({ success: true, available: !existing });
  } catch (error) {
    console.error('Check email error:', error);
    res.status(500).json({ success: false, error: 'Could not check email availability.' });
  }
});

// ─── POST /api/v1/auth/send-otp ──────────────────────────────────────────────
router.post('/send-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, purpose } = req.body;

    if (!email || !purpose) {
      res.status(400).json({ success: false, error: 'Email and purpose are required.' });
      return;
    }
    if (!['registration', 'password_reset'].includes(purpose)) {
      res.status(400).json({ success: false, error: 'Invalid request.' });
      return;
    }

    if (purpose === 'registration') {
      const existing = await prisma.user.findUnique({
        where:  { email: email.toLowerCase().trim() },
        select: { isEmailVerified: true },
      });
      if (existing?.isEmailVerified === true) {
        res.json({ success: true, message: 'If this email is eligible, a code has been sent.' });
        return;
      }
    }

    if (purpose === 'password_reset') {
      const existing = await prisma.user.findUnique({
        where:  { email: email.toLowerCase().trim() },
        select: { id: true },
      });
      if (!existing) {
        res.json({ success: true, message: 'If an account exists for that email, a code has been sent.' });
        return;
      }
    }

    const otp = await issueOtp(email.toLowerCase().trim(), purpose);
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from:    'flowfitworkouts@cctamcc.site',
      to:      email,
      subject: 'Your FlowFit Code',
      html:    `Your FlowFit verification code is: <strong>${otp}</strong>`,
    });

    res.json({ success: true, message: 'If this email is eligible, a code has been sent.' });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, error: 'Could not send verification code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/verify-otp ────────────────────────────────────────────
router.post('/verify-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, otp, purpose } = req.body;
    if (!email || !otp || !purpose) {
      res.status(400).json({ success: false, error: 'Email, OTP and purpose are required.' });
      return;
    }
    const valid = await verifyOtp(email.toLowerCase().trim(), String(otp), purpose);
    if (!valid) {
      res.status(400).json({ success: false, error: 'Incorrect or expired code. Please request a new one.' });
      return;
    }
    res.json({ success: true, verified: true });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, error: 'Could not verify code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/forgot-password ───────────────────────────────────────
router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, error: 'Email is required.' });
      return;
    }
    const normalised = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: normalised }, select: { id: true } });

    if (!user) {
      // Consistent response regardless of whether the email exists
      res.json({ success: true, message: 'If an account exists for that email, a reset code has been sent.' });
      return;
    }

    const otp = await issueOtp(normalised, 'password_reset');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from:    'flowfitworkouts@cctamcc.site',
      to:      normalised,
      subject: 'Password Reset Code',
      html:    `Your FlowFit password reset code is: <strong>${otp}</strong>. It expires in ${OTP_TTL_MINUTES} minutes.`,
    });

    res.json({ success: true, message: 'If an account exists for that email, a reset code has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, error: 'Could not send reset code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/verify-reset-otp ──────────────────────────────────────
router.post('/verify-reset-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, error: 'Email and OTP are required.' });
      return;
    }
    const normalised = email.toLowerCase().trim();
    const valid = await verifyOtp(normalised, String(otp), 'password_reset');
    if (!valid) {
      res.status(400).json({ success: false, error: 'Incorrect or expired code. Please request a new one.' });
      return;
    }
    // Short-lived token (5 min) authorises /reset-password without re-verifying the OTP
    const resetToken = jwt.sign({ email: normalised, purpose: 'password_reset' }, JWT_ACCESS_SECRET, { expiresIn: '5m' });
    res.json({ success: true, verified: true, resetToken });
  } catch (error) {
    console.error('Verify reset OTP error:', error);
    res.status(500).json({ success: false, error: 'Could not verify code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/reset-password ────────────────────────────────────────
router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, resetToken } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and new password are required.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
      return;
    }
    if (!resetToken) {
      res.status(400).json({ success: false, error: 'Reset token is required. Please restart the reset flow.' });
      return;
    }

    let decoded: { email: string; purpose: string };
    try {
      decoded = jwt.verify(resetToken, JWT_ACCESS_SECRET) as { email: string; purpose: string };
    } catch {
      res.status(401).json({ success: false, error: 'Reset link has expired. Please request a new code.' });
      return;
    }

    if (decoded.purpose !== 'password_reset' || decoded.email !== email.toLowerCase().trim()) {
      res.status(401).json({ success: false, error: 'Invalid request.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() }, select: { id: true } });
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid request.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    await prisma.otpCode.deleteMany({
      where: { email: email.toLowerCase().trim(), purpose: 'password_reset' },
    }).catch(() => { /* non-critical */ });

    // Clear the cookie — all DB tokens are gone so any existing cookie would cause
    // a 401 on the next /refresh call. Force a clean re-login.
    clearRefreshCookie(res);
    res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Failed to reset password. Please try again.' });
  }
});

// ─── POST /api/v1/auth/login ──────────────────────────────────────────────────
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

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await storeRefreshToken(user.id, refreshToken);

    const { password: _, ...safeUser } = user;
    setRefreshCookie(res, refreshToken);
    res.status(200).json({ success: true, data: { user: safeUser, accessToken } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/v1/auth/logout ────────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.ff_refresh;
    if (token) await deleteRefreshToken(token);
  } catch { /* always clear cookie even if DB delete fails */ }
  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

// ─── POST /api/v1/auth/refresh ───────────────────────────────────────────────
router.post('/refresh', async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.ff_refresh;

  if (!refreshToken) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  // Verify JWT signature and expiry first — if the JWT itself is expired or
  // tampered the DB lookup is pointless.
  let decoded: { userId: string };
  try {
    decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: string };
  } catch {
    clearRefreshCookie(res);
    res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
    return;
  }

  try {
    const stored = await prisma.refreshToken.findUnique({
      where: { token: hashToken(refreshToken) },
    });

    // Token not in DB (already rotated, revoked, or password was changed)
    // or the DB-level expiry is in the past — treat both as session expired.
    if (!stored || stored.expiresAt < new Date()) {
      clearRefreshCookie(res);
      res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      clearRefreshCookie(res);
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    // Generate the new token pair first so we have the real hash before
    // touching the DB. Then atomically delete the old record and insert the
    // new one — if a second concurrent /refresh call arrives with the same
    // cookie, the deleteMany will match nothing and the create will still
    // succeed (the cookie will have been replaced by then anyway).
    const tokens = generateTokens(user.id);
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.refreshToken.deleteMany({ where: { token: hashToken(refreshToken) } }),
      prisma.refreshToken.create({
        data: { userId: user.id, token: hashToken(tokens.refreshToken), expiresAt: newExpiresAt },
      }),
    ]);

    setRefreshCookie(res, tokens.refreshToken);
    res.status(200).json({ success: true, data: { accessToken: tokens.accessToken } });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ success: false, error: 'Could not refresh session. Please try again.' });
  }
});

// ─── GET /api/v1/auth/me ─────────────────────────────────────────────────────
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: {
        id: true, name: true, email: true, role: true,
        isEmailVerified: true, lastLogin: true, createdAt: true, profile: true,
      },
    });
    if (!user) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user.' });
  }
});

// ─── POST /api/v1/auth/change-password ───────────────────────────────────────
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
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
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    const passwordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatch) {
      res.status(401).json({ success: false, error: 'Current password is incorrect.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // FIX 3: Delete ALL refresh tokens from DB and clear the cookie in the same
    // response. Previously the DB records were deleted but the cookie was left
    // set, so the next /refresh call would get a 401 "session expired" and log
    // the user out unexpectedly. Now we proactively clear the cookie and tell
    // the client to re-authenticate so the logout is deliberate and predictable.
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    clearRefreshCookie(res);
    res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please log in again with your new password.',
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Failed to change password.' });
  }
});

router.use('/', phoneOtpRoutes);

export default router;
