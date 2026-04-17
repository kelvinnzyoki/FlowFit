/**
 * FLOWFIT — Phone OTP Routes
 * POST /api/v1/auth/send-phone-otp
 * POST /api/v1/auth/verify-phone-otp
 *
 * OTP delivery:   Resend API  (RESEND_API_KEY)  — SMS via Resend's SMS product.
 * Rate limiting:  3 code-verify attempts per code, 3 sends per phone per hour.
 * Carrier check:  Validates any Kenyan mobile number (Safaricom, Airtel, Telkom,
 *                 Equitel) — NOT locked to Safaricom only.
 * Code storage:   bcrypt-hashed 6-digit code stored in PhoneOtp table (Prisma).
 *                 Expires after 5 minutes. One-time use.
 */

import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../config/db.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// ── Env ───────────────────────────────────────────────────────────────────────
const RESEND_API_KEY  = process.env.RESEND_API_KEY!;
const RESEND_FROM_SMS = process.env.RESEND_FROM_SMS || 'FlowFit';  // sender name

if (!RESEND_API_KEY) {
  console.warn('[phone-otp] RESEND_API_KEY is not set — SMS delivery will fail');
}

// ── Constants ─────────────────────────────────────────────────────────────────
const OTP_TTL_SECONDS    = 300;  // 5 minutes
const MAX_SENDS_PER_HOUR = 3;    // per phone number
const MAX_VERIFY_TRIES   = 3;    // wrong-code attempts before code is voided
const BCRYPT_ROUNDS      = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise to 254XXXXXXXXX; returns null if invalid Kenyan mobile */
function normaliseKenyanPhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('07') || d.startsWith('01')) d = '254' + d.slice(1);
  // Accept all Kenyan carriers: 2547xxxxxxxx and 2541xxxxxxxx
  if (/^254[71]\d{8}$/.test(d)) return d;
  return null;
}

/** Cryptographically random 6-digit code */
function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

/** Send SMS via Resend SMS API */
async function sendSmsViaResend(to: string, code: string): Promise<void> {
  const body = {
    from:    RESEND_FROM_SMS,
    to:      '+' + to,  // Resend expects E.164 with +
    text:    `Your FlowFit verification code is ${code}. It expires in 5 minutes. Do not share this code.`,
  };

  const res = await fetch('https://api.resend.com/sms', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Resend SMS failed (${res.status}): ${err?.message ?? 'unknown error'}`);
  }
}

// ── POST /api/v1/auth/send-phone-otp ─────────────────────────────────────────
/**
 * Rate limit: max 3 OTP sends per phone per hour.
 * Invalidates any existing unused code for this phone+user before creating new one.
 */
router.post('/send-phone-otp', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { phone: rawPhone } = req.body;
    if (!rawPhone || typeof rawPhone !== 'string') {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }

    const phone = normaliseKenyanPhone(rawPhone.trim());
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Use a valid Kenyan mobile number (e.g. 0712 345 678)',
      });
    }

    const userId = req.user.id;
    const now    = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);

    // ── Rate limit: count sends in the last hour for this phone ──────────────
    const recentSends = await prisma.phoneOtp.count({
      where: {
        phone,
        createdAt: { gte: oneHourAgo },
      },
    });

    if (recentSends >= MAX_SENDS_PER_HOUR) {
      return res.status(429).json({
        success:   false,
        message:   `Too many verification requests. You can request a new code up to ${MAX_SENDS_PER_HOUR} times per hour. Please wait before trying again.`,
        retryAfter: 3600,
      });
    }

    // ── Void any live code for this user+phone ────────────────────────────────
    await prisma.phoneOtp.updateMany({
      where: {
        userId,
        phone,
        usedAt:    null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },   // mark as used = invalidated
    });

    // ── Generate, hash, and persist new code ─────────────────────────────────
    const code      = generateOtp();
    const codeHash  = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);

    await prisma.phoneOtp.create({
      data: {
        userId,
        phone,
        codeHash,
        expiresAt,
        attempts: 0,
      },
    });

    // ── Send SMS ──────────────────────────────────────────────────────────────
    await sendSmsViaResend(phone, code);

    console.log(`[phone-otp] Code sent to ${phone.slice(0, 7)}***${phone.slice(-2)} for user ${userId}`);

    return res.json({
      success:   true,
      message:   `Verification code sent to ${phone.slice(0, 7)}*****`,
      expiresIn: OTP_TTL_SECONDS,
    });

  } catch (error: any) {
    console.error('[phone-otp] send-phone-otp error:', error?.message ?? error);
    return res.status(500).json({ success: false, message: 'Failed to send verification code. Please try again.' });
  }
});

// ── POST /api/v1/auth/verify-phone-otp ───────────────────────────────────────
/**
 * Rate limit: max 3 wrong attempts per code before it is voided.
 * On success: marks code as used, sets user.mpesaPhone + user.phoneVerified.
 */
router.post('/verify-phone-otp', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { phone: rawPhone, code } = req.body;

    if (!rawPhone || !code) {
      return res.status(400).json({ success: false, message: 'phone and code are required' });
    }

    if (!/^\d{6}$/.test(String(code).trim())) {
      return res.status(400).json({ success: false, message: 'code must be a 6-digit number' });
    }

    const phone  = normaliseKenyanPhone(String(rawPhone).trim());
    const userId = req.user.id;
    const now    = new Date();

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }

    // ── Find the latest live OTP for this user+phone ──────────────────────────
    const otp = await prisma.phoneOtp.findFirst({
      where: {
        userId,
        phone,
        usedAt:    null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: 'No active code found for this number. Please request a new one.',
      });
    }

    // ── Attempt-count rate limit ──────────────────────────────────────────────
    if (otp.attempts >= MAX_VERIFY_TRIES) {
      // Void the code
      await prisma.phoneOtp.update({ where: { id: otp.id }, data: { usedAt: now } });
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new verification code.',
        retryAfter: 0,
      });
    }

    // ── Check code ────────────────────────────────────────────────────────────
    const match = await bcrypt.compare(String(code).trim(), otp.codeHash);

    if (!match) {
      // Increment attempts
      const newAttempts = otp.attempts + 1;
      const voidCode    = newAttempts >= MAX_VERIFY_TRIES;

      await prisma.phoneOtp.update({
        where: { id: otp.id },
        data: {
          attempts: newAttempts,
          usedAt:   voidCode ? now : undefined,
        },
      });

      if (voidCode) {
        return res.status(429).json({
          success: false,
          message: 'Too many incorrect attempts. Please request a new verification code.',
        });
      }

      const attemptsLeft = MAX_VERIFY_TRIES - newAttempts;
      return res.status(400).json({
        success: false,
        message: `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} remaining.`,
        attemptsLeft,
      });
    }

    // ── Code correct — mark used + verify the user's phone ───────────────────
    await prisma.$transaction([
      prisma.phoneOtp.update({
        where: { id: otp.id },
        data:  { usedAt: now },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          mpesaPhone:      phone,
          phoneVerified:   true,
          phoneVerifiedAt: now,
        },
      }),
    ]);

    console.log(`[phone-otp] Phone ${phone.slice(0, 7)}***${phone.slice(-2)} verified for user ${userId}`);

    return res.json({
      success:       true,
      phoneVerified: true,
      message:       'Phone number verified successfully.',
    });

  } catch (error: any) {
    console.error('[phone-otp] verify-phone-otp error:', error?.message ?? error);
    return res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

export default router;
