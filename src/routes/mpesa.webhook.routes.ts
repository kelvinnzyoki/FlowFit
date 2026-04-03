/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX-002: Race Condition Prevention in M-Pesa Webhook
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * ISSUE: Multiple webhook deliveries can process same payment twice
 * SEVERITY: CRITICAL (double-billing risk)
 * FILE: mpesa_webhook_routes.ts
 * 
 * PROBLEM:
 * ```typescript
 * const existing = await prisma.webhookEvent.findUnique({ ... });
 * if (existing) return; // ← Gap here!
 * // ... 100ms gap ...
 * await processPayment(); // ← Both webhooks can reach here
 * ```
 * 
 * SOLUTION: Database-level atomic lock using unique constraint + transaction
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';
import { parseStkCallback } from '../services/mpesa.service.js';
import { handleMpesaSuccess, handleMpesaFailure } from '../services/subscription.service.js';

const router = Router();

// ═══ EXISTING CODE (keep as is) ═══
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

// ═══ VALIDATION ENDPOINT (unchanged) ═══
router.post('/validation', (req: Request, res: Response) => {
  if (!validateSafaricomAuth(req)) {
    console.warn('[mpesa-webhook] Rejected validation from IP:', req.ip);
    return res.json({ ResultCode: '1', ResultDesc: 'Rejected' });
  }
  return res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ═══ FIX-002: ENHANCED CALLBACK HANDLER WITH RACE CONDITION PROTECTION ═══
// ═══════════════════════════════════════════════════════════════════════════

router.post('/callback', async (req: Request, res: Response) => {
  // STEP 1: Always ACK immediately (Safaricom requirement)
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });

  // STEP 2: Validate auth
  if (!validateSafaricomAuth(req)) {
    console.warn('[mpesa-webhook] Callback rejected — invalid auth from IP:', req.ip);
    return;
  }

  // STEP 3: Parse callback
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

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX-002: ATOMIC IDEMPOTENCY CHECK + LOCK
  // 
  // Uses database transaction + unique constraint to prevent race conditions.
  // 
  // HOW IT WORKS:
  // 1. Try to create webhookEvent record (externalId is UNIQUE in schema)
  // 2. If record already exists → unique constraint violation → catch block
  // 3. If we created it → we own the lock → proceed with processing
  // 4. All writes happen in same transaction → atomic
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    // ATOMIC OPERATION: Try to claim this webhook
    await prisma.$transaction(async (tx) => {
      // This will throw if another instance already created this record
      await tx.webhookEvent.create({
        data: {
          externalId:     checkoutRequestId,
          provider:       'mpesa',
          eventType:      isSuccess ? 'stk_success' : 'stk_failed',
          responseStatus: 200,
          createdAt:      new Date(), // Explicitly set timestamp
        },
      });

      console.log(`[mpesa-webhook] Lock acquired for ${checkoutRequestId}`);

      // ═══ LOCK ACQUIRED - PROCESS PAYMENT ═══
      
      // Verify transaction exists
      const mpesaTx = await tx.mpesaTransaction.findUnique({
        where:   { checkoutRequestId },
        include: { subscription: true },
      });

      if (!mpesaTx || !mpesaTx.subscription) {
        console.warn(`[mpesa-webhook] No subscription found for ${checkoutRequestId}`);
        // Don't throw - we want to keep the webhook lock
        return;
      }

      const subscription = mpesaTx.subscription;

      if (isSuccess) {
        if (!receiptNumber) {
          console.error('[mpesa-webhook] Success callback missing receiptNumber');
          return;
        }

        // Process success inside this transaction
        await processPaymentSuccess(
          tx,
          mpesaTx,
          subscription,
          checkoutRequestId,
          receiptNumber,
          amount ?? 0
        );

        console.log(`[mpesa-webhook] ✅ SUCCESS: Subscription ${subscription.id} activated`);
      } else {
        // Process failure
        console.log(`[mpesa-webhook] ❌ FAILURE for ${checkoutRequestId}: ${resultDesc}`);

        if (['ACTIVE', 'TRIALING'].includes(subscription.status)) {
          console.log(`[mpesa-webhook] Keeping ${subscription.status} — recording failure only`);
        }

        await processPaymentFailure(
          tx,
          mpesaTx,
          subscription,
          checkoutRequestId,
          String(resultCode),
          resultDesc
        );
      }
    });

  } catch (err: any) {
    // UNIQUE CONSTRAINT VIOLATION = DUPLICATE WEBHOOK
    if (err.code === 'P2002' || err.message?.includes('Unique constraint')) {
      console.log(`[mpesa-webhook] Duplicate callback detected for ${checkoutRequestId} — already processed`);
      return; // Exit silently
    }

    // REAL ERROR - LOG IT
    console.error(`[mpesa-webhook] Error processing ${checkoutRequestId}:`, err);
    
    // Still record in webhook log (outside transaction) for debugging
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

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - All writes happen in the same transaction (tx)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process successful M-Pesa payment
 * ALL writes happen in the passed transaction - atomic!
 */
async function processPaymentSuccess(
  tx: any,
  mpesaTx: any,
  subscription: any,
  checkoutRequestId: string,
  receiptNumber: string,
  amountKes: number
) {
  // 1. Update M-Pesa transaction status
  await tx.mpesaTransaction.update({
    where: { checkoutRequestId },
    data: {
      status:         'SUCCESS',
      receiptNumber:  receiptNumber,
      completedAt:    new Date(),
    },
  });

  // 2. Create payment record
  await tx.payment.create({
    data: {
      subscriptionId:   subscription.id,
      mpesaReceiptNumber: receiptNumber,
      amountCents:      amountKes * 100, // Store as KES cents
      currency:         'KES',
      status:           'succeeded',
      provider:         'MPESA',
    },
  });

  // 3. Calculate new period based on interval
  const now = new Date();
  let newPeriodEnd: Date;

  if (subscription.interval === 'YEARLY') {
    newPeriodEnd = new Date(now);
    newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
  } else {
    newPeriodEnd = new Date(now);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
  }

  // 4. Update subscription
  const prevStatus = subscription.status;
  const isRenewal = mpesaTx.isRenewal === true;

  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status:              'ACTIVE',
      currentPeriodStart:  now,
      currentPeriodEnd:    newPeriodEnd,
      activatedAt:         prevStatus !== 'ACTIVE' ? now : undefined,
      mpesaLastRenewalAt:  isRenewal ? now : undefined,
    },
  });

  // 5. Log event
  await tx.subscriptionLog.create({
    data: {
      subscriptionId: subscription.id,
      event:          isRenewal ? 'PAYMENT_SUCCEEDED' : 'MPESA_STK_SUCCESS',
      previousStatus: prevStatus,
      newStatus:      'ACTIVE',
      metadata: {
        checkoutRequestId,
        receiptNumber,
        amountKes,
        isRenewal,
      },
    },
  });
}

/**
 * Process failed M-Pesa payment
 * ALL writes happen in the passed transaction - atomic!
 */
async function processPaymentFailure(
  tx: any,
  mpesaTx: any,
  subscription: any,
  checkoutRequestId: string,
  resultCode: string,
  resultDesc: string
) {
  const isRenewal = mpesaTx.isRenewal === true;

  // 1. Update M-Pesa transaction status
  await tx.mpesaTransaction.update({
    where: { checkoutRequestId },
    data: {
      status:       'FAILED',
      failureCode:  resultCode,
      failureReason: resultDesc,
      completedAt:  new Date(),
    },
  });

  // 2. Create failed payment record
  await tx.payment.create({
    data: {
      subscriptionId: subscription.id,
      amountCents:    mpesaTx.amountKes * 100,
      currency:       'KES',
      status:         'failed',
      failureMessage: resultDesc,
      provider:       'MPESA',
    },
  });

  // 3. Update subscription status (only if it's a renewal failure)
  if (isRenewal && subscription.status === 'ACTIVE') {
    const now = new Date();
    const gracePeriodEnd = new Date(now);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 3); // 3-day grace

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status:          'GRACE_PERIOD',
        currentPeriodEnd: gracePeriodEnd,
        autoRenew:       false, // Stop auto-renewals
      },
    });

    await tx.subscriptionLog.create({
      data: {
        subscriptionId: subscription.id,
        event:          'GRACE_PERIOD_STARTED',
        previousStatus: 'ACTIVE',
        newStatus:      'GRACE_PERIOD',
        metadata: {
          checkoutRequestId,
          failureReason: resultDesc,
          failureCode:   resultCode,
        },
      },
    });
  } else {
    // Initial payment failed - just log it
    await tx.subscriptionLog.create({
      data: {
        subscriptionId: subscription.id,
        event:          'MPESA_STK_FAILED',
        previousStatus: subscription.status,
        newStatus:      subscription.status,
        metadata: {
          checkoutRequestId,
          failureReason: resultDesc,
          failureCode:   resultCode,
        },
      },
    });
  }
}

// ═══ C2B CONFIRMATION (unchanged) ═══
router.post('/confirmation', async (req: Request, res: Response) => {
  console.log('[mpesa-webhook] C2B confirmation received:', JSON.stringify(req.body));
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

export default router;
