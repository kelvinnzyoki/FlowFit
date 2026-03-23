// FLOWFIT — Cron Job HTTP Handlers
//
// These routes are called by Vercel Cron Jobs on a schedule (see vercel.json).
// Each endpoint runs one type of background work.
//
// Security: CRON_SECRET header required — set the same value in:
//   - Your Vercel environment variables (CRON_SECRET)
//   - vercel.json cron job config (added automatically by Vercel)
//
// Vercel sets x-vercel-cron-signature on all cron-triggered requests.
// We also accept Authorization: Bearer <CRON_SECRET> for local testing.
//
// Cron schedule (set in vercel.json):
//   /api/v1/internal/cron/reminders  — "0 8 * * *"    (daily at 08:00 UTC)
//   /api/v1/internal/cron/renewals   — "0 * * * *"    (every hour)
//   /api/v1/internal/cron/retries    — "0 */6 * * *"  (every 6 hours)
//   /api/v1/internal/cron/expiry     — "*/30 * * * *" (every 30 minutes)

import { Router, Request, Response } from 'express';
import {
  runRenewalReminders,
  runMpesaRenewals,
  runRetries,
  runExpiry,
} from '../services/subscription.service.js';

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────
function verifyCronSecret(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If no secret set, only allow in development
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'CRON_SECRET not configured' });
      return false;
    }
    return true;
  }

  // Vercel Cron signature (preferred)
  const vercelSig = req.headers['x-vercel-cron-signature'];
  if (vercelSig === secret) return true;

  // Bearer token (for local testing with curl/Postman)
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${secret}`) return true;

  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

// ── POST /internal/cron/reminders ─────────────────────────────────────────────
// Send renewal reminder notifications to users expiring within 3 days.
// Schedule: daily at 08:00 UTC
router.post('/reminders', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  const start = Date.now();
  try {
    const result = await runRenewalReminders();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /reminders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /internal/cron/renewals ──────────────────────────────────────────────
// Trigger M-Pesa STK Push for subscriptions expiring within the next hour.
// Schedule: every hour
router.post('/renewals', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  const start = Date.now();
  try {
    const result = await runMpesaRenewals();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /renewals error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /internal/cron/retries ───────────────────────────────────────────────
// Retry failed M-Pesa STK pushes (24h interval, max 3 attempts).
// Schedule: every 6 hours
router.post('/retries', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  const start = Date.now();
  try {
    const result = await runRetries();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /retries error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /internal/cron/expiry ────────────────────────────────────────────────
// Expire trials, grace periods, stale transactions, apply due downgrades.
// Schedule: every 30 minutes
router.post('/expiry', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  const start = Date.now();
  try {
    const result = await runExpiry();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /expiry error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
