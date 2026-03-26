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
  if (process.env.MPESA_ENVIRONMENT !== 'production') return true;
  if (process.env.MPESA_VALIDATE_IP !== 'true') return true;

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          ?? req.socket?.remoteAddress ?? '';
  return SAFARICOM_IPS.has(ip);
}

// ── Validation URL ─────────────────────────────────────────────────────────────
router.post('/validation', (req: Request, res: Response) => {
  if (!validateSafaricomIp(req)) {
    console.warn('[mpesa-webhook] Rejected validation from unknown IP:', req.ip);
    return res.json({ ResultCode: '1', ResultDesc: 'Rejected' });
  }
  return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

 
      // ── STK Push Callback ──────────────────────────────────────────────────────────
router.post('/callback', async (req: Request, res: Response) => {
  // Always ACK immediately to Safaricom
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });

  if (!validateSafaricomIp(req)) {
    console.warn('[mpesa-webhook] Callback from unknown IP rejected:', req.ip);
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

  // Idempotency check
  const existing = await prisma.webhookEvent.findUnique({
    where: { externalId: checkoutRequestId },
  });
  if (existing) {
    console.log(`[mpesa-webhook] Duplicate callback skipped for ${checkoutRequestId}`);
    return;
  }

  try {
    // Find M-Pesa transaction + linked subscription
    const mpesaTx = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
      include: { subscription: true },
    });

    if (!mpesaTx || !mpesaTx.subscription) {
      console.warn(`[mpesa-webhook] No subscription found for checkoutRequestId: ${checkoutRequestId}`);
      return;
    }

    const subscription = mpesaTx.subscription;

    // SUCCESS - handle both string '0' and number 0 safely
    const isSuccess = resultCode === '0' || resultCode === 0;

    if (isSuccess) {
      if (!receiptNumber) throw new Error('Missing receiptNumber on success');

      await handleMpesaSuccess(checkoutRequestId, receiptNumber, amount ?? 0);

      // FORCE ACTIVE — this is what hides the "PAYMENT FAILED" banner
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
        },
      });

      console.log(`[mpesa-webhook] ✅ SUCCESS: Subscription ${subscription.id} set to ACTIVE`);
    } 
    // FAILURE
    else {
      console.log(`[mpesa-webhook] ❌ FAILURE for ${checkoutRequestId}: ${resultDesc}`);

      // Never downgrade already good subscriptions
      if (['ACTIVE', 'TRIALING'].includes(subscription.status)) {
        console.log(`[mpesa-webhook] Ignored failure — keeping ${subscription.status}`);
        await handleMpesaFailure(checkoutRequestId, String(resultCode), resultDesc);
        return;
      }

      await handleMpesaFailure(checkoutRequestId, String(resultCode), resultDesc);
      console.log(`[mpesa-webhook] Marked as PAST_DUE`);
    }
  } catch (err: any) {
    console.error(`[mpesa-webhook] Error processing ${checkoutRequestId}:`, err);
  }

  // Record event for idempotency
  await prisma.webhookEvent.create({
    data: {
      externalId: checkoutRequestId,
      provider: 'mpesa',
      eventType: (resultCode === '0' || resultCode === 0) ? 'stk_success' : 'stk_failed',
      responseStatus: 200,
    },
  }).catch(e => console.error('[mpesa-webhook] Failed to log event:', e));
});

// ── C2B Confirmation URL ───────────────────────────────────────────────────────
router.post('/confirmation', async (req: Request, res: Response) => {
  console.log('[mpesa-webhook] C2B confirmation received:', JSON.stringify(req.body));
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

export default router;
