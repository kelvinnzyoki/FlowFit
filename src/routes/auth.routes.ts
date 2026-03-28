import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../config/db.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

const JWT_ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'change_me_access';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change_me_refresh';
const ACCESS_EXPIRES     = '15m';
const REFRESH_EXPIRES    = '7d';

const OTP_TTL_MINUTES    = 10;   // OTP expires after 10 minutes
const OTP_LENGTH         = 6;    // 6-digit code

// ─── Token helpers ────────────────────────────────────────────────────────────

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

// ─── OTP helpers ──────────────────────────────────────────────────────────────

/** Generate a cryptographically random numeric OTP string. */
function generateOtp(): string {
  // Generate a number in [0, 10^OTP_LENGTH) with leading-zero padding
  const max = Math.pow(10, OTP_LENGTH);
  const otp = crypto.randomInt(0, max);
  return String(otp).padStart(OTP_LENGTH, '0');
}

/**
 * Issue a fresh OTP for the given email + purpose.
 * Deletes any previous unused OTPs for the same email+purpose first
 * so only one code is ever valid at a time.
 * Returns the plaintext OTP (caller decides how to deliver it).
 */
async function issueOtp(email: string, purpose: string): Promise<string> {
  const code      = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  const codeHash  = await bcrypt.hash(code, 10);

  // Invalidate previous codes for this email+purpose
  await prisma.otpCode.deleteMany({ where: { email, purpose } });

  await prisma.otpCode.create({
    data: { email, codeHash, purpose, expiresAt },
  });

  return code;  // plaintext — handed back to the route to send/return
}

/**
 * Verify an OTP.  Returns true and marks it used if correct and unexpired.
 * Returns false otherwise (wrong code, expired, already used).
 */
async function verifyOtp(email: string, code: string, purpose: string): Promise<boolean> {
  const record = await prisma.otpCode.findFirst({
    where: {
      email,
      purpose,
      usedAt:    null,                    // not already consumed
      expiresAt: { gt: new Date() },      // not expired
    },
    orderBy: { createdAt: 'desc' },       // most recent first
  });

  if (!record) return false;

  const match = await bcrypt.compare(code, record.codeHash);
  if (!match) return false;

  // Mark consumed so it can't be replayed
  await prisma.otpCode.update({
    where: { id: record.id },
    data:  { usedAt: new Date() },
  });

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

    res.status(201).json({ success: true, data: { user, accessToken, refreshToken } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

// ─── GET /api/v1/auth/check-email ────────────────────────────────────────────
// Called by register.html as the user types their email.
// Returns { available: true } if no account exists with that email.
router.get('/check-email', async (req: Request, res: Response) => {
  try {
    const email = (req.query.email as string)?.toLowerCase().trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, error: 'A valid email is required.' });
      return;
    }

    const existing = await prisma.user.findUnique({
      where:  { email },
      select: { id: true },
    });

    res.json({ success: true, available: !existing });
  } catch (error) {
    console.error('Check email error:', error);
    res.status(500).json({ success: false, error: 'Could not check email availability.' });
  }
});

// ─── POST /api/v1/auth/send-otp ──────────────────────────────────────────────
// Called by register.html after step-1 validation to send a 6-digit code.
// Body: { email, purpose: 'registration' }
// Response: { success: true, message, otp } — otp is included in dev/no-email-service
// setups so the frontend can display it. In production wire in an email provider
// here and remove otp from the response.
router.post('/send-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, purpose } = req.body;

    if (!email || !purpose) {
      res.status(400).json({ success: false, error: 'Email and purpose are required.' });
      return;
    }

    const validPurposes = ['registration', 'password_reset'];
    if (!validPurposes.includes(purpose)) {
      res.status(400).json({ success: false, error: 'Invalid OTP purpose.' });
      return;
    }

    // For registration: reject if email already registered
    if (purpose === 'registration') {
      const existing = await prisma.user.findUnique({
        where:  { email: email.toLowerCase().trim() },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({ success: false, error: 'An account with that email already exists.' });
        return;
      }
    }

    // For password_reset: reject if email NOT registered
    if (purpose === 'password_reset') {
      const existing = await prisma.user.findUnique({
        where:  { email: email.toLowerCase().trim() },
        select: { id: true },
      });
      if (!existing) {
        // Security: don't reveal whether the email exists — send the same message
        // but don't actually issue an OTP for non-existent accounts
        res.json({
          success: true,
          message: 'If an account exists for that email, a code has been sent.',
        });
        return;
      }
    }

    const otp = await issueOtp(email.toLowerCase().trim(), purpose);

    // TODO: replace the line below with your email provider (e.g. Resend, SendGrid):
    //   await sendEmail({ to: email, subject: 'Your FlowFit code', body: `Code: ${otp}` });
    // Until then the code is returned in the response so the frontend can display it.
    console.log(`[OTP] ${purpose} code for ${email}: ${otp}`);  // server log only

    res.json({
      success: true,
      message: `A ${OTP_TTL_MINUTES}-minute verification code has been sent to ${email}.`,
      // Remove the line below once you wire in an email provider:
      otp,
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, error: 'Could not send verification code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/verify-otp ────────────────────────────────────────────
// Called by register.html to confirm the 6-digit code before creating the account.
// Body: { email, otp, purpose: 'registration' }
// Response: { success: true, verified: true }
router.post('/verify-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, otp, purpose } = req.body;

    if (!email || !otp || !purpose) {
      res.status(400).json({ success: false, error: 'Email, OTP and purpose are required.' });
      return;
    }

    const valid = await verifyOtp(email.toLowerCase().trim(), String(otp), purpose);

    if (!valid) {
      res.status(400).json({
        success: false,
        error: 'Incorrect or expired code. Please request a new one.',
      });
      return;
    }

    res.json({ success: true, verified: true });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, error: 'Could not verify code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/forgot-password ───────────────────────────────────────
// Called by login.html when user enters their email on the forgot-password screen.
// Body: { email }
// Sends a 6-digit reset code.  Uses the same OTP table as registration (different purpose).
router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ success: false, error: 'Email is required.' });
      return;
    }

    const normalised = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({
      where:  { email: normalised },
      select: { id: true },
    });

    // Always return the same message regardless of whether the email exists.
    // This prevents email enumeration attacks.
    if (!user) {
      res.json({
        success: true,
        message: 'If an account exists for that email, a reset code has been sent.',
      });
      return;
    }

    const otp = await issueOtp(normalised, 'password_reset');

    // TODO: wire in email provider here
    console.log(`[OTP] password_reset code for ${normalised}: ${otp}`);

    res.json({
      success: true,
      message: `A ${OTP_TTL_MINUTES}-minute reset code has been sent to ${email}.`,
      otp,  // remove once email is wired
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, error: 'Could not send reset code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/verify-reset-otp ──────────────────────────────────────
// Called by login.html after user enters the reset code.
// Body: { email, otp }
// On success returns a short-lived resetToken (signed JWT) that must be presented
// to /reset-password to authorise the password change.
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
      res.status(400).json({
        success: false,
        error: 'Incorrect or expired code. Please request a new one.',
      });
      return;
    }

    // Issue a short-lived reset token (5 minutes) so the client can authorise
    // /reset-password without re-verifying the OTP.
    const resetToken = jwt.sign(
      { email: normalised, purpose: 'password_reset' },
      JWT_ACCESS_SECRET,
      { expiresIn: '5m' },
    );

    res.json({
      success:    true,
      verified:   true,
      resetToken,   // client passes this back to /reset-password
    });
  } catch (error) {
    console.error('Verify reset OTP error:', error);
    res.status(500).json({ success: false, error: 'Could not verify code. Please try again.' });
  }
});

// ─── POST /api/v1/auth/reset-password ────────────────────────────────────────
// Called by login.html after OTP verification with the new password.
// Body: { email, password, resetToken }
// Validates the resetToken issued by /verify-reset-otp before allowing the change.
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

    // Validate the reset token issued by /verify-reset-otp
    let decoded: { email: string; purpose: string };
    try {
      decoded = jwt.verify(resetToken, JWT_ACCESS_SECRET) as { email: string; purpose: string };
    } catch {
      res.status(401).json({ success: false, error: 'Reset token has expired. Please request a new code.' });
      return;
    }

    if (decoded.purpose !== 'password_reset' || decoded.email !== email.toLowerCase().trim()) {
      res.status(401).json({ success: false, error: 'Invalid reset token.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where:  { email: email.toLowerCase().trim() },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'Account not found.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Update password and invalidate all active sessions for security
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data:  { password: hashedPassword },
      }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    // Clean up any remaining OTP codes for this email
    await prisma.otpCode.deleteMany({
      where: { email: email.toLowerCase().trim(), purpose: 'password_reset' },
    }).catch(() => { /* non-critical */ });

    res.json({
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    });
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
    res.status(200).json({ success: true, data: { user: safeUser, accessToken, refreshToken } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/v1/auth/logout ────────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await deleteRefreshToken(refreshToken);
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  } catch {
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  }
});

// ─── POST /api/v1/auth/refresh ────────────────────────────────────────────────
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ success: false, error: 'Refresh token required.' });
      return;
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: string };
    const stored  = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });

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

// ─── GET /api/v1/auth/me ─────────────────────────────────────────────────────
router.get('/me', authenticate, async (req: Request, res: Response) => {
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
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    res.status(200).json({ success: true, message: 'Password changed successfully. Please log in again.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Failed to change password.' });
  }
});

export default router;
