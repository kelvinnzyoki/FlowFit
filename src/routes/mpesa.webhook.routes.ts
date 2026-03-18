/**
 * FLOWFIT — M-Pesa Webhook Handler
 *
 * Handles callbacks from Safaricom Daraja for STK Push results.
 *
 * Security model:
 *   1. Validation URL: Daraja calls this before processing — always return "Y"
 *   2. Confirmation URL: Daraja sends final result here
 *   3. WebhookEvent table provides idempotency (checkoutRequestId = unique key)
 *   4. Callback IP can optionally be whitelisted (Safaricom IPs below)
 *   5. All writes in transactions
 *   6. Always respond 200 — Daraja retries on non-2xx
 *
 * Safaricom callback IPs (optional IP whitelist):
 *   196.201.214.200, 196.201.214.206, 196.201.213.114
 *   196.201.214.207, 196.201.214.208, 196.201.213.44
 *   196.201.212.127, 196.201.212.138, 196.201.212.129
 *   196.201.212.136, 196.201.212.74,  196.201.212.69
 *
 * Route registration:
 *   app.post('/api/webhooks/mpesa/callback',    mpesaWebhookRouter)
 *   app.post('/api/webhooks/mpesa/validation',  mpesaWebhookRouter)
 *   app.post('/api/webhooks/mpesa/confirmation',mpesaWebhookRouter)
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { parseStkCallback } from '../services/mpesa.service.js';
import { handleMpesaSuccess, handleMpesaFailure } from '../services/subscription.service.js';

const router = Router();

// ── Optional: Safaricom IP whitelist ─────────────────────────────────────────
const SAFARICOM_IPS = new Set([
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74',  '196.201.212.69',
]);

function validateSafaricomIp(req: Request): boolean {
  // Only enforce in production
  if (process.env.MPESA_ENVIRONMENT !== 'production') return true;
  if (process.env.MPESA_VALIDATE_IP !== 'true') return true;

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          ?? req.socket?.remoteAddress ?? '';
  return SAFARICOM_IPS.has(ip);
}

// ── Validation URL ─────────────────────────────────────────────────────────────
// Daraja calls this to validate the merchant before sending callbacks.
// Must respond with { ResultCode: "0", ResultDesc: "Accepted" } within 8 seconds.
router.post('/validation', (req: Request, res: Response) => {
  if (!validateSafaricomIp(req)) {
    console.warn('[mpesa-webhook] Rejected validation from unknown IP:', req.ip);
    res.json({ ResultCode: '1', ResultDesc: 'Rejected' });
    return;
  }
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

// ── STK Push Callback ──────────────────────────────────────────────────────────
// Primary callback for Lipa Na M-Pesa Online (STK Push) results.
router.post('/callback', async (req: Request, res: Response) => {
  // Always respond 200 first — Daraja has an 8-second timeout and will retry on failure
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });

  if (!validateSafaricomIp(req)) {
    console.warn('[mpesa-webhook] Callback from unknown IP rejected:', req.ip);
    return;
  }

  let parsed: ReturnType<typeof parseStkCallback>;
  try {
    parsed = parseStkCallback(req.body);
  } catch (err: any) {
    console.error('[mpesa-webhook] Failed to parse callback:', err.message, JSON.stringify(req.body));
    return;
  }

  const { checkoutRequestId, resultCode, resultDesc, receiptNumber, amount } = parsed;

  // Idempotency — don't process the same callback twice
  const existing = await prisma.webhookEvent.findUnique({
    where: { externalId: checkoutRequestId },
  });
  if (existing) {
    console.log(`[mpesa-webhook] Duplicate callback for ${checkoutRequestId} — skipped`);
    return;
  }

  let error: string | null = null;
  try {
    if (resultCode === '0') {
      // ── Payment succeeded ──────────────────────────────────────────────────
      if (!receiptNumber) throw new Error('Missing MpesaReceiptNumber on success callback');
      await handleMpesaSuccess(checkoutRequestId, receiptNumber, amount ?? 0);
    } else {
      // ── Payment failed / cancelled ─────────────────────────────────────────
      await handleMpesaFailure(checkoutRequestId, resultCode, resultDesc);
    }
  } catch (err: any) {
    error = err.message;
    console.error(`[mpesa-webhook] Error processing ${checkoutRequestId}:`, err);
  }

  // Record in idempotency table
  await prisma.webhookEvent.create({
    data: {
      externalId:     checkoutRequestId,
      provider:       'mpesa',
      eventType:      resultCode === '0' ? 'stk_success' : 'stk_failed',
      responseStatus: error ? 207 : 200,
      error,
    },
  }).catch((e: any) => console.error('[mpesa-webhook] Failed to record event:', e));
});

// ── C2B Confirmation URL ───────────────────────────────────────────────────────
// Used when registered as a C2B shortcode (paybill/till confirmations).
// Not needed for STK Push-only flows — keep as a no-op stub.
router.post('/confirmation', async (req: Request, res: Response) => {
  console.log('[mpesa-webhook] C2B confirmation received:', JSON.stringify(req.body));
  // TODO: implement C2B confirmation handling if you use a paybill/till number
  // for manual payments in addition to STK Push.
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

export default router;
