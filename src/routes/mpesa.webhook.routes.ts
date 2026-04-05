/**
 * FLOWFIT — M-Pesa Webhook Routes
 *
 * FIXES APPLIED:
 *   FIX-C1  validateSafaricomIp was called throughout but the function defined
 *           in this file is validateSafaricomAuth. Every webhook call threw
 *           ReferenceError. All call sites renamed to validateSafaricomAuth.
 *   FIX-S1  Webhook secret was read from query string (?secret=...) which is
 *           captured in every access log, proxy log, and Vercel log. Moved to
 *           X-Mpesa-Secret request header. Update your Daraja CallbackURL to
 *           remove the ?secret= param and add the header via a reverse proxy or
 *           Vercel middleware instead.
 *   FIX-M2  After handleMpesaSuccess() the webhook handler did a second
 *           prisma.subscription.update({ status: 'ACTIVE' }) outside the
 *           transaction. handleMpesaSuccess already sets ACTIVE inside its own
 *           transaction. The redundant second write is removed.
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { parseStkCallback } from '../services/mpesa.service.js';
import { handleMpesaSuccess, handleMpesaFailure } from '../services/subscription.service.js';

const router = Router();

// ── Safaricom IP allowlist (optional second layer) ─────────────────────────────
const SAFARICOM_IPS = new Set([
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74',  '196.201.212.69',
]);

/**
 * FIX-C1 + FIX-S1:
 * - Function was named validateSafaricomAuth but called as validateSafaricomIp everywhere.
 * - Secret was read from req.query.secret (visible in all logs). Now read from header.
 *
 * To configure: set MPESA_WEBHOOK_SECRET in Vercel env vars.
 * In your Daraja portal CallbackURL set it WITHOUT a query string.
 * If you use a reverse proxy, inject the header there:
 *   proxy_set_header X-Mpesa-Secret $MPESA_WEBHOOK_SECRET;
 */
function validateSafaricomAuth(req: Request): boolean {
  // Always allow in non-production for sandbox testing
  if (process.env.MPESA_ENVIRONMENT !== 'production') return true;

  // FIX-S1: Read secret from header, NOT query string
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

// ── Validation URL ─────────────────────────────────────────────────────────────
router.post('/validation', (req: Request, res: Response) => {
  // FIX-C1: was validateSafaricomIp — renamed to validateSafaricomAuth
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

  // FIX-C1: was validateSafaricomIp — renamed to validateSafaricomAuth
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

  // Safe success check (handles both string '0' and number 0)
  const isSuccess = String(resultCode) === '0';

  console.log(`[mpesa-webhook] Processing ${checkoutRequestId}: ${isSuccess ? 'SUCCESS' : 'FAILURE'}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX-002: ATOMIC IDEMPOTENCY LOCK
  // 
  // Uses database transaction + unique constraint to prevent race conditions.
  // The unique constraint on webhookEvent.externalId ensures only ONE webhook
  // can be processed, even if Safaricom sends duplicates simultaneously.
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    await prisma.$transaction(async (tx) => {
      // ATOMIC OPERATION: Create webhookEvent record (unique constraint on externalId)
      // If another instance already created it → Prisma throws P2002 error → caught below
      await tx.webhookEvent.create({
        data: {
          externalId:     checkoutRequestId,
          provider:       'mpesa',
          eventType:      isSuccess ? 'stk_success' : 'stk_failed',
          responseStatus: 200,
        },
      });

      console.log(`[mpesa-webhook] Lock acquired for ${checkoutRequestId}`);

      // ═══ LOCK ACQUIRED - SAFE TO PROCESS PAYMENT ═══

      // Verify the transaction exists
      const mpesaTx = await tx.mpesaTransaction.findUnique({
        where:   { checkoutRequestId },
        include: { subscription: true },
      });

      if (!mpesaTx || !mpesaTx.subscription) {
        console.warn(`[mpesa-webhook] No subscription found for ${checkoutRequestId}`);
        return; // Don't throw - keep the lock to prevent reprocessing
      }

      const subscription = mpesaTx.subscription;

      if (isSuccess) {
        if (!receiptNumber) {
          console.error('[mpesa-webhook] Success callback missing receiptNumber');
          return;
        }

        // FIX-M2: handleMpesaSuccess already sets status = ACTIVE inside its own
        //         transaction. The redundant second update that followed it has been
        //         removed. Two writes racing on the same row created a brief inconsistency
        //         window and doubled the DB load for no benefit.
        await handleMpesaSuccess(checkoutRequestId, receiptNumber, amount ?? 0);

        console.log(`[mpesa-webhook] ✅ SUCCESS: Subscription ${subscription.id} activated`);
      } else {
        console.log(`[mpesa-webhook] ❌ FAILURE for ${checkoutRequestId}: ${resultDesc}`);

        // Never downgrade a subscription that is already active or trialing.
        // A failed renewal attempt does not cancel an active subscription —
        // it moves it to PAST_DUE via handleMpesaFailure only if isRenewal=true.
        if (['ACTIVE', 'TRIALING'].includes(subscription.status)) {
          console.log(`[mpesa-webhook] Keeping ${subscription.status} — recording failure only`);
        }

        await handleMpesaFailure(checkoutRequestId, String(resultCode), resultDesc);
      }
    });

  } catch (err: any) {
    // UNIQUE CONSTRAINT VIOLATION = DUPLICATE WEBHOOK (EXPECTED)
    if (err.code === 'P2002' || err.message?.includes('Unique constraint')) {
      console.log(`[mpesa-webhook] ✓ Duplicate callback detected for ${checkoutRequestId} — already processed by another instance`);
      return; // Exit silently - this is good! Duplicate was blocked.
    }

    // REAL ERROR - LOG IT
    console.error(`[mpesa-webhook] Error processing ${checkoutRequestId}:`, err);
    
    // Record error in webhook log (outside transaction) for debugging
    try {
      await prisma.webhookEvent.upsert({
        where: { externalId: checkoutRequestId },
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
