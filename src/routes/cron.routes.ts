// FLOWFIT — Cron Job HTTP Handlers
//
// FIXES APPLIED:
//   FIX-H3  CronLock model exists in schema but was never used.
//           Without locking, concurrent Vercel invocations query the same
//           subscriptions and fire duplicate STK pushes, double-billing users.
//           Added acquireCronLock / releaseCronLock that use the CronLock table
//           as a distributed mutex. If a lock is already held and unexpired,
//           the handler returns 409 immediately.

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
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
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'CRON_SECRET not configured' });
      return false;
    }
    return true;
  }

  const vercelSig = req.headers['x-vercel-cron-signature'];
  if (vercelSig === secret) return true;

  const auth = req.headers['authorization'];
  if (auth === `Bearer ${secret}`) return true;

  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

// ── FIX-H3: Distributed lock ───────────────────────────────────────────────────
// Uses the CronLock table (already in schema) as a mutex.
// Pattern:
//   1. Delete any expired lock for this job.
//   2. Try to create a new lock. If it already exists (unique constraint),
//      another instance is running — return false.
//   3. On completion (success or error), always release the lock.

async function acquireCronLock(jobName: string, ttlMs = 6 * 60 * 1000): Promise<boolean> {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // Delete expired lock so a crashed previous run doesn't block forever
  await prisma.cronLock.deleteMany({
    where: { id: jobName, expiresAt: { lt: now } },
  }).catch(() => {/* non-critical */});

  try {
    await prisma.cronLock.create({
      data: { id: jobName, lockedAt: now, expiresAt },
    });
    return true;
  } catch {
    // Unique constraint violation — another instance holds the lock
    return false;
  }
}

async function releaseCronLock(jobName: string): Promise<void> {
  await prisma.cronLock.delete({ where: { id: jobName } }).catch(() => {/* already deleted */});
}

// ── POST /internal/cron/reminders ─────────────────────────────────────────────
router.post('/reminders', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  const locked = await acquireCronLock('renewal-reminders');
  if (!locked) {
    res.status(409).json({ ok: false, error: 'Job already running' });
    return;
  }

  const start = Date.now();
  try {
    const result = await runRenewalReminders();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /reminders error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await releaseCronLock('renewal-reminders');
  }
});

// ── POST /internal/cron/renewals ──────────────────────────────────────────────
router.post('/renewals', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  const locked = await acquireCronLock('mpesa-renewals');
  if (!locked) {
    res.status(409).json({ ok: false, error: 'Job already running' });
    return;
  }

  const start = Date.now();
  try {
    const result = await runMpesaRenewals();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /renewals error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await releaseCronLock('mpesa-renewals');
  }
});

// ── POST /internal/cron/retries ───────────────────────────────────────────────
router.post('/retries', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  const locked = await acquireCronLock('mpesa-retries');
  if (!locked) {
    res.status(409).json({ ok: false, error: 'Job already running' });
    return;
  }

  const start = Date.now();
  try {
    const result = await runRetries();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /retries error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await releaseCronLock('mpesa-retries');
  }
});

// ── POST /internal/cron/expiry ────────────────────────────────────────────────
router.post('/expiry', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  const locked = await acquireCronLock('subscription-expiry', 3 * 60 * 1000);
  if (!locked) {
    res.status(409).json({ ok: false, error: 'Job already running' });
    return;
  }

  const start = Date.now();
  try {
    const result = await runExpiry();
    res.json({ ok: true, ...result, durationMs: Date.now() - start });
  } catch (err: any) {
    console.error('[cron] /expiry error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await releaseCronLock('subscription-expiry');
  }
});

export default router;
