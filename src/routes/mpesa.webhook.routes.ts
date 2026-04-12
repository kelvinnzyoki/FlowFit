/**
 * FLOWFIT — M-Pesa Webhook Routes
 *
 * BUGS FIXED IN THIS VERSION:
 *
 *   FIX-C1  validateSafaricomIp renamed to validateSafaricomAuth throughout (v2, unchanged).
 *
 *   FIX-S1  Webhook secret moved from query string to X-Mpesa-Secret header (v2, unchanged).
 *
 *   FIX-M2  Redundant second prisma.subscription.update after handleMpesaSuccess removed (v2).
 *
 *   FIX-8   requireAuth was used on the /initiate route but never imported.
 *           Runtime threw: ReferenceError: requireAuth is not defined.
 *           Fixed: imported as `authenticate` from the auth middleware and aliased.
 *
 *   FIX-9   initMpesaPayment was used but never imported from the service file.
 *           Runtime threw: ReferenceError: initMpesaPayment is not defined.
 *           Fixed: added to imports from mpesa.service.
 *
 *   FIX-10  req.user?.id — `user` is not on Express's built-in Request type.
 *           The /initiate route now uses AuthRequest (from the auth middleware)
 *           so TypeScript knows about req.user.
 *
 *   FIX-11  catch (error) — error typed as `unknown` in strict TS mode.
 *           error.message was an implicit-any access, now cast to `any`.
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { parseStkCallback, initMpesaPayment } from '../services/mpesa.service.js';   // FIX-9
import { handleMpesaSuccess, handleMpesaFailure } from '../services/subscription.service.js';
import { authenticate, AuthRequest } from '../middleware/auth.middleware.js';          // FIX-8

const router = Router();

// ── Safaricom IP allowlist ─────────────────────────────────────────────────────
const SAFARICOM_IPS = new Set([
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74',  '196.201.212.69',
]);

function validateSafaricomAuth(req: Request): boolean {
  if (process.env.MPESA_ENVIRONMENT !== 'production') return true;

  const webhookSecret  = process.env.MPESA_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-mpesa-secret'];

  if (!webhookSecret) {
    console.error('[mpesa-webhook] MPESA_WEBHOOK_SECRET is not set — rejecting all callbacks');
    return false;
  }

  if (providedSecret !== webhookSecret) {
    console.error('[mpesa-webhook] Unauthorized: invalid X-Mpesa-Secret header');
    return false;
  }

  return true;
}

// ── Initiate STK Push ─────────────────────────────────────────────────────────
// FIX-8:  authenticate is now imported (was used as requireAuth but never imported).
// FIX-10: Uses AuthRequest so req.user is typed correctly.
router.post('/initiate', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { planId, phoneNumber, interval } = req.body;

    // FIX-10: req.user is typed on AuthRequest — no longer an implicit `any` access.
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!planId || !phoneNumber || !interval) {
      return res.status(400).json({ error: 'planId, phoneNumber, and interval are required.' });
    }

    if (interval !== 'MONTHLY' && interval !== 'YEARLY') {
      return res.status(400).json({ error: 'interval must be MONTHLY or YEARLY.' });
    }

    // FIX-9: initMpesaPayment now imported correctly.
    // FIX-7: initMpesaPayment now returns a typed result — not undefined.
    const result = await initMpesaPayment(planId, phoneNumber, interval, userId);

    return res.json({
      success:           true,
      checkoutRequestId: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
      subscriptionId:    result.subscriptionId,
      customerMessage:   result.customerMessage,
    });

  } catch (err: any) { // FIX-11: cast to `any` so .message is accessible
    console.error('[mpesa-initiate] Error:', err.message ?? err);
    return res.status(400).json({ error: err.message ?? 'Failed to initiate M-Pesa payment' });
  }
});

// ── Validation URL ─────────────────────────────────────────────────────────────
router.post('/validation', (req: Request, res: Response) => {
  if (!validateSafaricomAuth(req)) {
    console.warn('[mpesa-webhook] Rejected validation from IP:', req.ip);
    return res.json({ ResultCode: '1', ResultDesc: 'Rejected' });
  }
  return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

// ── STK Push Callback ──────────────────────────────────────────────────────────
router.post('/callback', async (req: Request, res: Response) => {
  // Always ACK immediately so Daraja does not retry
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });

  if (!validateSafaricomAuth(req)) {
    console.warn('[mpesa-webhook] Callback rejected — invalid auth from IP:', req.ip);
    return;
  }

  let parsed: ReturnType<typeof parseStkCallback>;
  try {
    parsed = parseStkCallback(req.body);
  } catch (err: any) {
    console.error('[mpesa-webhook] Failed to parse callback:', err.message);
    return;
  }

  const { checkoutRequestId, resultCode, resultDesc, receiptNumber, amount } = parsed;
  const isSuccess = String(resultCode) === '0';

  console.log(`[mpesa-webhook] Processing ${checkoutRequestId}: ${isSuccess ? 'SUCCESS' : 'FAILURE'}`);

  try {
    await prisma.$transaction(async (tx) => {
      // Atomic idempotency lock — unique constraint on externalId prevents
      // duplicate processing even if Safaricom sends the callback twice.
      await tx.webhookEvent.create({
        data: {
          externalId:     checkoutRequestId,
          provider:       'mpesa',
          eventType:      isSuccess ? 'stk_success' : 'stk_failed',
          responseStatus: 200,
        },
      });

      console.log(`[mpesa-webhook] Lock acquired for ${checkoutRequestId}`);

      const mpesaTx = await tx.mpesaTransaction.findUnique({
        where:   { checkoutRequestId },
        include: { subscription: true },
      });

      if (!mpesaTx) {
        console.warn(`[mpesa-webhook] No MpesaTransaction found for ${checkoutRequestId}`);
        return;
      }

      // FIX-5 dependency: subscription is now always set on new transactions
      // (created in initMpesaPayment). Log a warning for legacy rows that
      // pre-date this fix and still have subscriptionId = null.
      if (!mpesaTx.subscription) {
        console.warn(
          `[mpesa-webhook] MpesaTransaction ${mpesaTx.id} has no linked subscription ` +
          `(pre-fix legacy row for ${checkoutRequestId}). Skipping activation.`,
        );
        return;
      }

      const subscription = mpesaTx.subscription;

      if (isSuccess) {
        if (!receiptNumber) {
          console.error('[mpesa-webhook] Success callback missing receiptNumber');
          return;
        }

        // FIX-M2: handleMpesaSuccess already sets ACTIVE inside its own transaction.
        //         The redundant second update has been removed.
        await handleMpesaSuccess(checkoutRequestId, receiptNumber, amount ?? 0);

        console.log(`[mpesa-webhook] ✅ SUCCESS: Subscription ${subscription.id} activated`);
      } else {
        console.log(`[mpesa-webhook] ❌ FAILURE for ${checkoutRequestId}: ${resultDesc}`);

        // Never downgrade a subscription that is already active or trialing.
        if (['ACTIVE', 'TRIALING'].includes(subscription.status)) {
          console.log(`[mpesa-webhook] Keeping ${subscription.status} — recording failure only`);
        }

        await handleMpesaFailure(checkoutRequestId, String(resultCode), resultDesc);
      }
    });

  } catch (err: any) {
    // P2002 = unique constraint violation = duplicate callback (expected, not an error)
    if (err.code === 'P2002' || err.message?.includes('Unique constraint')) {
      console.log(
        `[mpesa-webhook] ✓ Duplicate callback for ${checkoutRequestId} — already processed`,
      );
      return;
    }

    console.error(`[mpesa-webhook] Error processing ${checkoutRequestId}:`, err);

    // Log the error outside the transaction (transaction already rolled back)
    try {
      await prisma.webhookEvent.upsert({
        where:  { externalId: checkoutRequestId },
        create: {
          externalId:     checkoutRequestId,
          provider:       'mpesa',
          eventType:      'processing_error',
          responseStatus: 500,
          error:          err.message,
        },
        update: {
          error:          err.message,
          responseStatus: 500,
        },
      });
    } catch (logErr) {
      console.error('[mpesa-webhook] Failed to log error:', logErr);
    }
  }
});

// ── C2B Confirmation URL ───────────────────────────────────────────────────────
router.post('/confirmation', async (req: Request, res: Response) => {
  console.log('[mpesa-webhook] C2B confirmation received:', JSON.stringify(req.body));
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

export default router;
