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

// Replace the existing validateSafaricomIp function
function validateSafaricomAuth(req: Request): boolean {
  // 1. Check if we are in development
  if (process.env.MPESA_ENVIRONMENT !== 'production') return true;

  // 2. Verify a secret token passed in the query string of the CallBackURL
  // You must update your Daraja Portal CallBackURL to: 
  // https://your-api.com/api/v1/webhooks/mpesa?secret=SOME_LONG_RANDOM_KEY
  const webhookSecret = process.env.MPESA_WEBHOOK_SECRET;
  const providedSecret = req.query.secret;

  if (!webhookSecret || providedSecret !== webhookSecret) {
    console.error('[mpesa-webhook] Unauthorized access attempt: Invalid Secret');
    return false;
  }

  return true;
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
  // Always ACK immediately
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

  // Safe success check (handles both string '0' and number 0)
  const isSuccess = String(resultCode) === '0';

  // Idempotency
  const existing = await prisma.webhookEvent.findUnique({
    where: { externalId: checkoutRequestId },
  });
  if (existing) {
    console.log(`[mpesa-webhook] Duplicate callback skipped for ${checkoutRequestId}`);
    return;
  }

  try {
    // Find via MpesaTransaction + subscription
    const mpesaTx = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
      include: { subscription: true },
    });

    if (!mpesaTx || !mpesaTx.subscription) {
      console.warn(`[mpesa-webhook] No subscription found for ${checkoutRequestId}`);
      return;
    }

    const subscription = mpesaTx.subscription;

    if (isSuccess) {
      if (!receiptNumber) throw new Error('Missing receiptNumber on success');

      await handleMpesaSuccess(checkoutRequestId, receiptNumber, amount ?? 0);

      // FORCE ACTIVE — this clears the PAST_DUE banner on frontend
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
        },
      });

      console.log(`[mpesa-webhook] ✅ SUCCESS: Subscription ${subscription.id} set to ACTIVE`);
    } 
    else {
      console.log(`[mpesa-webhook] ❌ FAILURE for ${checkoutRequestId}: ${resultDesc}`);

      // Never downgrade active/trialing subscriptions
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
      eventType: isSuccess ? 'stk_success' : 'stk_failed',
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
