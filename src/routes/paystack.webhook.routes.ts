// SECURITY PATCHES APPLIED: FIX-4, FIX-5, FIX-7
/**
 * FLOWFIT — Paystack Webhook Handler (FINAL CORRECTED)
 *
 * Fixes the race war:
 * - verifyPayment is read-only for code creation: it never calls POST /subscription
 *   when checkout was initialized with a Paystack plan code.
 * - charge.success records payment/reference only; it NEVER creates an orphan
 *   Subscription row if metadata/reference lookup fails.
 * - subscription.create stores subscription_code + email_token and activates only
 *   the intended row, matching by metadata.subscriptionId first, then existing
 *   subscription_code, then paystackReference/invoice transaction reference, then
 *   INCOMPLETE customer+plan fallback.
 */

import express, { Router, Request, Response } from 'express';
import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import prisma from '../config/db.js';
import {
  verifyPaystackWebhook,
  fetchPaystackSubscription,
  PaystackWebhookEvent,
} from '../services/paystack.service.js';
import {
  notifySubActivated,
  notifyTrialStarted,
  notifyTrialEnding,
  notifySubRenewed,
  notifyPaymentFailed,
  notifySubCancelled,
} from '../services/notification.service.js';

const router = Router();

const PAYSTACK_WEBHOOK_IPS = new Set(
  (process.env.PAYSTACK_WEBHOOK_IP_ALLOWLIST ?? '52.31.139.75,52.49.173.169,52.214.14.220')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean),
);

function normaliseIp(ip: string | undefined): string {
  return String(ip ?? '').replace(/^::ffff:/, '').trim();
}

function paystackIpAllowlist(req: Request, res: Response, next: () => void) {
  const forwardedFor = String(req.headers['x-forwarded-for'] ?? '').split(',')[0];
  const ip = normaliseIp(forwardedFor || req.ip || req.socket.remoteAddress);

  if (PAYSTACK_WEBHOOK_IPS.size > 0 && !PAYSTACK_WEBHOOK_IPS.has(ip)) {
    console.warn('[Paystack webhook] Rejected request from non-Paystack IP', { ip });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}


const PAYSTACK_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'ACTIVE',
  'non-renewing': 'ACTIVE',
  attention: 'PAST_DUE',
  completed: 'EXPIRED',
  cancelled: 'CANCELLED',
};

function mapPaystackStatus(ps: string): SubscriptionStatus {
  return PAYSTACK_STATUS_MAP[ps] ?? 'EXPIRED';
}

function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from);
  if (interval === 'YEARLY') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function pickSubscriptionCode(data: any): string | undefined {
  return data?.subscription?.subscription_code
    ?? data?.subscription_code
    ?? data?.subscription?.code
    ?? undefined;
}

function pickEmailToken(data: any): string | undefined {
  return data?.subscription?.email_token
    ?? data?.email_token
    ?? undefined;
}

function pickCustomerCode(data: any): string | undefined {
  return data?.customer?.customer_code
    ?? data?.customer_code
    ?? undefined;
}

function pickCustomerEmail(data: any): string | undefined {
  return data?.customer?.email
    ?? data?.customer_email
    ?? undefined;
}

function pickPlanCode(data: any): string | undefined {
  return data?.plan?.plan_code
    ?? data?.plan_code
    ?? undefined;
}

function pickMetadata(data: any): Record<string, any> {
  return (
    data?.metadata
    ?? data?.subscription?.metadata
    ?? data?.invoice?.metadata
    ?? data?.most_recent_invoice?.metadata
    ?? {}
  ) as Record<string, any>;
}

function pickTransactionReference(data: any): string | undefined {
  return data?.most_recent_invoice?.transaction_reference
    ?? data?.most_recent_invoice?.transaction?.reference
    ?? data?.most_recent_invoice?.reference
    ?? data?.invoice?.transaction_reference
    ?? data?.invoice?.transaction?.reference
    ?? data?.invoice?.reference
    ?? data?.transaction?.reference
    ?? data?.reference
    ?? undefined;
}

async function findPlanIdByPaystackPlanCode(planCode?: string | null): Promise<string | null> {
  if (!planCode) return null;
  const plan = await prisma.plan.findFirst({
    where: {
      OR: [
        { paystackPlanCodeMonthly: planCode },
        { paystackPlanCodeYearly: planCode },
      ],
    },
    select: { id: true },
  });
  return plan?.id ?? null;
}

async function createPaymentOnce(params: {
  subscriptionId: string;
  reference?: string | null;
  amountCents: number;
  currency: string;
  status: string;
  paidAt?: Date | null;
  failureMessage?: string | null;
}, db: any = prisma) {
  if (!params.reference) return null;
  if (!Number.isFinite(params.amountCents) || params.amountCents <= 0) return null;

  const existing = await db.payment.findFirst({ where: { paystackReference: params.reference } });
  if (existing) return existing;

  return db.payment.create({
    data: {
      subscriptionId: params.subscriptionId,
      paystackReference: params.reference,
      amountCents: params.amountCents,
      currency: params.currency,
      status: params.status,
      paidAt: params.paidAt ?? null,
      provider: 'PAYSTACK',
      failureMessage: params.failureMessage ?? null,
    },
  }).catch(async (err: any) => {
    const existingAfterRace = await db.payment.findFirst({ where: { paystackReference: params.reference! } });
    if (existingAfterRace) return existingAfterRace;
    throw err;
  });
}

async function activateWithCodes(params: {
  subscriptionId: string;
  previousStatus: SubscriptionStatus;
  subscriptionCode: string;
  emailToken: string;
  reference?: string | null;
  customerCode?: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  source: string;
}, db: any = prisma) {
  await db.subscription.update({
    where: { id: params.subscriptionId },
    data: {
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      paystackSubscriptionCode: params.subscriptionCode,
      paystackEmailToken: params.emailToken,
      ...(params.reference ? { paystackReference: params.reference } : {}),
      ...(params.customerCode ? { paystackCustomerCode: params.customerCode } : {}),
      // If already ACTIVE (charge.success got there first), do not overwrite
      // period dates — they are already correct. Only patch the two missing codes.
      ...(params.previousStatus === 'ACTIVE'
        ? {}
        : {
            currentPeriodStart: params.currentPeriodStart,
            currentPeriodEnd: params.currentPeriodEnd,
            activatedAt: params.currentPeriodStart,
          }),
      cancelAtPeriodEnd: false,
      autoRenew: true,
    },
  });

  await db.subscriptionLog.create({
    data: {
      subscriptionId: params.subscriptionId,
      event: params.previousStatus === 'ACTIVE' ? 'PAYMENT_SUCCEEDED' : 'ACTIVATED',
      previousStatus: params.previousStatus,
      newStatus: 'ACTIVE',
      metadata: {
        source: params.source,
        paystackReference: params.reference ?? null,
        paystackSubscriptionCode: params.subscriptionCode,
        hasEmailToken: true,
      },
    },
  }).catch(() => undefined);
}

async function findSubscriptionForCreate(data: Record<string, any>) {
  // BUG-FIX-WEBHOOK-2: Paystack does NOT propagate the transaction's custom metadata
  // into the subscription.create payload automatically. pickMetadata checks
  // data.most_recent_invoice.metadata but that is the INVOICE metadata, not the
  // TRANSACTION metadata. As a result Strategy 1 (direct DB id via metaSubscriptionId)
  // always missed on the first attempt, causing processSubscriptionCreate to throw,
  // and Bug 1 (idempotency) then swallowed every retry.
  //
  // Fix: also check data.most_recent_invoice.transaction_metadata (some Paystack
  // versions embed it) and fall back to the transaction_reference for Strategy 3.
  // Strategy 4 (customerCode + INCOMPLETE + planId) is the guaranteed fallback.
  const meta = pickMetadata(data);
  // Also try the invoice's own metadata object if present
  const invoiceMeta = (data?.most_recent_invoice ?? data?.invoice ?? {}) as Record<string, any>;
  const mergedMeta = {
    ...meta,
    ...(invoiceMeta.metadata ?? {}),
    ...(invoiceMeta.transaction_metadata ?? {}),
  };
  const metaSubscriptionId = (mergedMeta.subscriptionId ?? meta.subscriptionId) as string | undefined;
  const subCode = pickSubscriptionCode(data);
  const reference = pickTransactionReference(data);
  const customerCode = pickCustomerCode(data);
  const customerEmail = pickCustomerEmail(data);
  const planCode = pickPlanCode(data);
  const planId = await findPlanIdByPaystackPlanCode(planCode);

// Strategy 1: direct DB ID from checkout metadata
  if (metaSubscriptionId) {
    const sub = await prisma.subscription.findUnique({ where: { id: metaSubscriptionId } });
    if (sub && !['CANCELLED', 'INCOMPLETE_EXPIRED', 'EXPIRED'].includes(sub.status)) {
      console.log(`[findSubscriptionForCreate] Strategy 1 matched sub ${sub.id} via metaSubscriptionId`);
      return sub;
    }
    console.warn(`[findSubscriptionForCreate] Strategy 1: metaSubscriptionId=${metaSubscriptionId} found but status=${sub?.status ?? 'not found'} — falling through`);
  }

  // Strategy 2: idempotency — sub already linked on a prior webhook
  if (subCode) {
    const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode } });
    if (sub) {
      console.log(`[findSubscriptionForCreate] Strategy 2 matched sub ${sub.id} via existing subCode`);
      return sub;
    }
  }

  // Strategy 3: transaction reference stored on INCOMPLETE row by charge.success
  if (reference) {
    const sub = await prisma.subscription.findFirst({
      where: {
        paystackReference: reference,
        provider: 'PAYSTACK',
        ...(planId ? { planId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (sub) {
      console.log(`[findSubscriptionForCreate] Strategy 3 matched sub ${sub.id} via reference=${reference}`);
      return sub;
    }
    console.warn(`[findSubscriptionForCreate] Strategy 3: reference=${reference} found nothing in DB`);
  }

  // Strategy 4a — INCOMPLETE rows first (the paid row we are looking for).
  // CRITICAL: orderBy desc so newest INCOMPLETE is picked, not an older TRIALING row.
  if (customerCode) {
    const sub = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        provider: 'PAYSTACK',
        status: 'INCOMPLETE',
        ...(planId ? { planId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (sub) {
      console.log(`[findSubscriptionForCreate] Strategy 4a matched INCOMPLETE sub ${sub.id} via customerCode`);
      return sub;
    }
  }

  if (customerEmail) {
    const user = await prisma.user.findUnique({ where: { email: customerEmail }, select: { id: true } });
    if (user) {
      const sub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          provider: 'PAYSTACK',
          status: 'INCOMPLETE',
          ...(planId ? { planId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (sub) {
        console.log(`[findSubscriptionForCreate] Strategy 4b matched INCOMPLETE sub ${sub.id} via email`);
        return sub;
      }
    }
  }

  // Strategy 4c — broader fallback: any active/trialing row that is missing email_token.
  // This covers the edge case where charge.success already activated the row but
  // subscription.create still needs to write email_token.
  if (customerCode) {
    const sub = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        provider: 'PAYSTACK',
        paystackEmailToken: null,
        status: 'INCOMPLETE',
        ...(planId ? { planId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (sub) {
      console.log(`[findSubscriptionForCreate] Strategy 4c matched sub ${sub.id} (status=${sub.status}, emailToken=null)`);
      return sub;
    }
  }

  if (customerEmail) {
    const user = await prisma.user.findUnique({ where: { email: customerEmail }, select: { id: true } });
    if (user) {
      const sub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          provider: 'PAYSTACK',
          paystackEmailToken: null,
          status: 'INCOMPLETE',
          ...(planId ? { planId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (sub) {
        console.log(`[findSubscriptionForCreate] Strategy 4d matched sub ${sub.id} via email (emailToken=null)`);
        return sub;
      }
    }
  }

  // 6) Paystack API fallback. subscription.create never reliably propagates
  // checkout metadata, so use the authoritative subscription object to recover
  // the customer code and bind codes to the matching unresolved DB row.
  if (subCode) {
    try {
      const paystackSub = await fetchPaystackSubscription(subCode);
      const apiCustomerCode = paystackSub.customer?.customer_code;
      if (apiCustomerCode) {
        const sub = await prisma.subscription.findFirst({
          where: {
            paystackCustomerCode: apiCustomerCode,
            provider: 'PAYSTACK',
            status: { notIn: ['CANCELLED', 'EXPIRED', 'INCOMPLETE_EXPIRED'] },
            ...(planId ? { planId } : {}),
          },
          orderBy: { createdAt: 'desc' },
        });
        if (sub) return sub;
      }
    } catch (apiErr: any) {
      console.error('[findSubscriptionForCreate] Paystack API fallback failed:', apiErr.message);
      // Do not throw here — let processSubscriptionCreate throw after this function returns null.
    }
  }

  // Strategy 5 — covers the race where charge.success processed first and left
  // the row in a non-INCOMPLETE status (e.g. ACTIVE), making Strategies 3 and 4
  // (both filtered to status:'INCOMPLETE') skip it. We key on paystackEmailToken: null
  // so we never accidentally overwrite a row that is already fully activated.
  // Also covers the case where charge.success stored subscription_code (Edit 2 above)
  // but subscription.create must still add the email_token to complete the record.
  if (customerCode) {
    const sub = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        provider: 'PAYSTACK',
        paystackEmailToken: null,
        ...(planId ? { planId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (sub) return sub;
  }

  if (customerEmail) {
    const user = await prisma.user.findUnique({
      where: { email: customerEmail },
      select: { id: true },
    });
    if (user) {
      const sub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          provider: 'PAYSTACK',
          paystackEmailToken: null,
          ...(planId ? { planId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (sub) return sub;
    }
  }

  return null;
}


async function validatePaystackAmountForSubscription(sub: any, interval: BillingInterval, rawAmount: unknown): Promise<number | null> {
  const receivedAmount = Number(rawAmount ?? 0);
  if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) {
    console.error('[Paystack webhook] Invalid Paystack amount; refusing to record payment/activate subscription', {
      subscriptionId: sub?.id,
      amount: rawAmount ?? null,
    });
    return null;
  }

  const plan = sub?.plan ?? await prisma.plan.findUnique({ where: { id: sub.planId } });
  const expectedKes = interval === 'YEARLY'
    ? Number((plan as any)?.mpesaYearlyKes ?? 0)
    : Number((plan as any)?.mpesaMonthlyKes ?? 0);
  const expectedAmount = expectedKes * 100;

  if (expectedAmount > 0 && receivedAmount < expectedAmount) {
    console.error('[Paystack webhook] Paystack amount below configured plan price; refusing to activate subscription', {
      subscriptionId: sub.id,
      planId: sub.planId,
      interval,
      receivedAmount,
      expectedAmount,
    });
    return null;
  }

  return receivedAmount;
}

async function processChargeSuccess(data: Record<string, any>): Promise<void> {
  const reference = data.reference as string | undefined;
  if (!reference) {
    console.warn('[Paystack webhook] charge.success without reference');
    return;
  }

  const meta = pickMetadata(data);
  const metaSubscriptionId = meta.subscriptionId as string | undefined;
  const userId = meta.userId as string | undefined;
  const planId = meta.planId as string | undefined;
  const interval = ((meta.interval as BillingInterval | undefined) ?? 'MONTHLY') as BillingInterval;
  const customerCode = pickCustomerCode(data) ?? meta.customerCode ?? undefined;
  const subscriptionCode = pickSubscriptionCode(data);
  const emailToken = pickEmailToken(data);
  const now = new Date();
  const currentPeriodEnd = data.subscription?.next_payment_date
    ? new Date(data.subscription.next_payment_date as string)
    : addInterval(now, interval);

  let sub = metaSubscriptionId
    ? await prisma.subscription.findUnique({ where: { id: metaSubscriptionId } })
    : null;

  if (!sub) {
    sub = await prisma.subscription.findFirst({
      where: { paystackReference: reference, provider: 'PAYSTACK' },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!sub && userId && planId) {
    sub = await prisma.subscription.findFirst({
      where: { userId, planId, provider: 'PAYSTACK', status: 'INCOMPLETE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!sub) {
    console.error('[Paystack webhook] charge.success could not match existing subscription; refusing to create orphan row', {
      reference,
      userId,
      planId,
      hasMetaSubscriptionId: !!metaSubscriptionId,
    });
    return;
  }

  const receivedAmount = await validatePaystackAmountForSubscription(sub, interval, data.amount);
  if (receivedAmount === null) return;

  if (subscriptionCode && emailToken) {
    await prisma.$transaction(async (tx) => {
      await createPaymentOnce({
        subscriptionId: sub.id,
        reference,
        amountCents: receivedAmount,
        currency: String(data.currency ?? 'KES').toUpperCase(),
        status: 'succeeded',
        paidAt: now,
      }, tx);
      await activateWithCodes({
      subscriptionId: sub.id,
      previousStatus: sub.status,
      subscriptionCode,
      emailToken,
      reference,
      customerCode,
      currentPeriodStart: now,
      currentPeriodEnd,
      source: 'charge.success',
      }, tx);
    });
    return;
  }

  // Payment succeeded, but Paystack has not provided management codes yet.
  // Keep it ACTIVE only if this row already had both management codes from an earlier
  // subscription.create event. Otherwise keep INCOMPLETE so the website does not unlock
  // before cancellation/reactivation/billing management can work.
  // Paystack never includes email_token on charge.success — it only ships on
  // subscription.create. Store subscription_code now if we have it so that
  // subscription.create's Strategy 1 (existing subCode lookup) can find this row.
  // Without this, the code was silently discarding subscription_code when email_token
  // was absent, causing all subsequent lookup strategies to fail.
  const alreadyHasCodes = !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken;
  await prisma.$transaction(async (tx) => {
    await createPaymentOnce({
      subscriptionId: sub.id,
      reference,
      amountCents: receivedAmount,
      currency: String(data.currency ?? 'KES').toUpperCase(),
      status: 'succeeded',
      paidAt: now,
    }, tx);

    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: alreadyHasCodes ? sub.status : 'INCOMPLETE',
        provider: 'PAYSTACK',
        interval,
        paystackReference: reference,
        ...(customerCode ? { paystackCustomerCode: customerCode } : {}),
        ...(subscriptionCode && !sub.paystackSubscriptionCode
          ? { paystackSubscriptionCode: subscriptionCode }
          : {}),
        currentPeriodStart: now,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
      },
    });

    await tx.subscriptionLog.create({
      data: {
        subscriptionId: sub.id,
        event: 'PAYMENT_SUCCEEDED',
        previousStatus: sub.status,
        newStatus: alreadyHasCodes ? sub.status : 'INCOMPLETE',
        metadata: {
          source: 'charge.success_pending_subscription.create',
          paystackReference: reference,
          reason: 'No subscription_code/email_token on charge.success payload',
        },
      },
    }).catch(() => undefined);
  });
}

async function processSubscriptionCreate(data: Record<string, any>): Promise<void> {
  const subCode = pickSubscriptionCode(data);
  const emailToken = pickEmailToken(data);
  const customerCode = pickCustomerCode(data);
  const reference = pickTransactionReference(data) ?? null;

  if (!subCode || !emailToken) {
    console.error('[Paystack webhook] subscription.create missing required codes', {
      hasSubCode: !!subCode,
      hasEmailToken: !!emailToken,
    });
    return;
  }

  const dbSub = await findSubscriptionForCreate(data);

  if (!dbSub) {
    throw new Error(
      `[subscription.create] No DB subscription matched for subCode=${subCode} ` +
      `customer=${pickCustomerCode(data)} plan=${pickPlanCode(data)}. ` +
      `Throwing so Paystack retries this webhook.`
    );
  }

  const now = new Date();
  const currentPeriodEnd = data.next_payment_date
    ? new Date(data.next_payment_date as string)
    : addInterval(now, dbSub.interval as BillingInterval);

  await activateWithCodes({
    subscriptionId: dbSub.id,
    previousStatus: dbSub.status,
    subscriptionCode: subCode,
    emailToken,
    reference,
    customerCode,
    currentPeriodStart: now,
    currentPeriodEnd,
    source: 'subscription.create',
  });

  const invoice = data.most_recent_invoice ?? data.invoice ?? {};
  const paymentReference = reference ?? invoice.transaction_reference ?? invoice.reference ?? null;
  // FIX-7: Only create a payment record when we have a real amount. Inserting
  // amountCents=0 when invoice fields are absent corrupts the user's payment history
  // and can confuse future reconciliation jobs that check amounts.
  const invoiceAmount = Number(invoice.amount ?? data.amount ?? 0);
  if (paymentReference && invoiceAmount > 0) {
    await createPaymentOnce({
      subscriptionId: dbSub.id,
      reference: paymentReference,
      amountCents: invoiceAmount,
      currency: String(invoice.currency ?? data.currency ?? 'KES').toUpperCase(),
      status: 'succeeded',
      paidAt: now,
    });
  } else if (paymentReference) {
    console.warn(
      `[subscription.create] No amount in payload for ref ${paymentReference} — ` +
      `payment record skipped to avoid inserting amountCents=0`
    );
  }

  if (dbSub.status !== 'ACTIVE') {
    const plan = await prisma.plan.findUnique({ where: { id: dbSub.planId }, select: { name: true } });
    notifySubActivated(dbSub.userId, plan?.name ?? 'Premium', 'PAYSTACK')
      .catch(err => console.error('[Paystack webhook] activation notification failed:', err));
  }

  if (dbSub.trialEndsAt && dbSub.trialEndsAt > now) {
    const plan = await prisma.plan.findUnique({ where: { id: dbSub.planId }, select: { name: true } });
    const daysLeft = Math.max(1, Math.ceil((dbSub.trialEndsAt.getTime() - Date.now()) / 86_400_000));
    notifyTrialStarted(dbSub.userId, plan?.name ?? 'Premium', daysLeft)
      .catch(err => console.error('[Paystack webhook] trial notification failed:', err));
  }
}

async function processEvent(event: PaystackWebhookEvent): Promise<void> {
  const { data } = event;

  switch (event.event) {
    case 'charge.success': {
      await processChargeSuccess(data);
      break;
    }

    case 'subscription.create': {
      await processSubscriptionCreate(data);
      break;
    }

    case 'subscription.disable': {
      const subCode = pickSubscriptionCode(data);
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode }, include: { plan: true } });
      if (!sub) return;

      // FIX-REACTIVATE-1: Paystack fires subscription.disable in TWO situations:
      //   (a) User cancels at period end → paystackDisable() → sub becomes "non-renewing"
      //   (b) Subscription is immediately/permanently cancelled
      // Previously this handler always set status=CANCELLED, which made (a) impossible
      // to reactivate: reactivateSubscription queries status IN ['ACTIVE','TRIALING']
      // and finds nothing because the row was already CANCELLED.
      //
      // Fix: if currentPeriodEnd is still in the future AND cancelAtPeriodEnd is true,
      // this is a period-end cancel — keep status ACTIVE so the user retains access and
      // can reactivate before the period ends. Only set CANCELLED when the period is over
      // or when the cancel was requested as immediate (cancelAtPeriodEnd was false).
      const now = new Date();
      const periodStillActive = !!sub.currentPeriodEnd && sub.currentPeriodEnd > now;
      const isPeriodEndCancel = periodStillActive && sub.cancelAtPeriodEnd === true;

      if (isPeriodEndCancel) {
        // Non-renewing: user retains access until currentPeriodEnd, can still reactivate.
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { cancelAtPeriodEnd: true, autoRenew: false },
        });

        const endDateStr = sub.currentPeriodEnd!.toLocaleDateString('en-KE', {
          day: 'numeric', month: 'long', year: 'numeric',
        });

        await prisma.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event: 'CANCEL_SCHEDULED',
            previousStatus: sub.status,
            newStatus: sub.status,
            metadata: { paystackSubCode: subCode, periodEnd: sub.currentPeriodEnd!.toISOString(), source: 'subscription.disable_period_end' },
          },
        }).catch(() => undefined);

        notifySubCancelled(sub.userId, (sub as any).plan?.name ?? 'your plan', endDateStr, false)
          .catch(err => console.error('[Paystack webhook] period-end cancel notification failed:', err));
      } else {
        // True immediate cancellation: period ended or explicit immediate cancel.
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { status: 'CANCELLED', cancelledAt: now, autoRenew: false, cancelAtPeriodEnd: false },
        });

        await prisma.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event: 'CANCELLED',
            previousStatus: sub.status,
            newStatus: 'CANCELLED',
            metadata: { paystackSubCode: subCode, reason: periodStillActive ? 'immediate_cancel' : 'period_ended' },
          },
        }).catch(() => undefined);

        notifySubCancelled(sub.userId, (sub as any).plan?.name ?? 'your plan', '', true)
          .catch(err => console.error('[Paystack webhook] cancellation notification failed:', err));
      }
      break;
    }

    case 'subscription.not_renew': {
      const subCode = pickSubscriptionCode(data);
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode }, include: { plan: true } });
      if (!sub) return;

      if (!sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date()) {
        console.warn('[Paystack webhook] Ignoring late subscription.not_renew for expired/currently-ended period', {
          subscriptionId: sub.id,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          nextPaymentDate: data.next_payment_date ?? null,
        });
        return;
      }

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true, autoRenew: false },
      });

      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event: 'CANCEL_SCHEDULED',
          previousStatus: sub.status,
          newStatus: sub.status,
          metadata: { paystackSubCode: subCode, nextPaymentDate: data.next_payment_date ?? null },
        },
      }).catch(() => undefined);

      const endDateStr = data.next_payment_date
        ? new Date(data.next_payment_date as string).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
      notifySubCancelled(sub.userId, (sub as any).plan?.name ?? 'your plan', endDateStr, false)
        .catch(err => console.error('[Paystack webhook] not-renew notification failed:', err));
      break;
    }

    case 'invoice.payment_failed': {
      const subCode = pickSubscriptionCode(data);
      const reference = data.reference as string | undefined;
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode }, include: { plan: true } });
      if (!sub) return;

      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });
      const failedAmount = Number(data.amount ?? 0);
      if (Number.isFinite(failedAmount) && failedAmount > 0) {
        await createPaymentOnce({
          subscriptionId: sub.id,
          reference: reference ?? null,
          amountCents: failedAmount,
          currency: String(data.currency ?? 'KES').toUpperCase(),
          status: 'failed',
          failureMessage: (data.gateway_response as string) ?? null,
        });
      } else {
        console.warn('[Paystack webhook] invoice.payment_failed had no positive amount; skipped payment row', {
          subscriptionId: sub.id,
          reference: reference ?? null,
          amount: data.amount ?? null,
        });
      }

      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event: 'PAYMENT_FAILED',
          previousStatus: sub.status,
          newStatus: 'PAST_DUE',
          metadata: { paystackSubCode: subCode, reference: reference ?? null },
        },
      }).catch(() => undefined);

      notifyPaymentFailed(sub.userId, (sub as any).plan?.name ?? 'your plan')
        .catch(err => console.error('[Paystack webhook] payment failed notification failed:', err));
      break;
    }

    case 'subscription.expiring_cards': {
      const subCode = pickSubscriptionCode(data);
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode }, include: { plan: true } });
      if (!sub) return;

      if (sub.status === 'TRIALING' && sub.trialEndsAt) {
        const msLeft = sub.trialEndsAt.getTime() - Date.now();
        const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
        notifyTrialEnding(sub.userId, (sub as any).plan?.name ?? 'your plan', daysLeft)
          .catch(err => console.error('[Paystack webhook] trial ending notification failed:', err));
      }

      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event: 'RENEWAL_REMINDER_SENT',
          previousStatus: sub.status,
          newStatus: sub.status,
          metadata: { paystackSubCode: subCode },
        },
      }).catch(() => undefined);
      break;
    }

    case 'subscription.disable_failed':
    case 'subscription.enable':
    case 'invoice.create':
    case 'invoice.update':
      break;

    default: {
      // FIX-4: Unknown event types are logged only. Previously this block called
      // mapPaystackStatus and wrote the result to the DB, which could accidentally
      // set a subscription to ACTIVE if any future/unrecognised Paystack event
      // carried data.status === 'active' or 'non-renewing'. Log and drop instead.
      console.log(
        `[Paystack webhook] Unhandled event type: ${event.event}`,
        {
          subCode: pickSubscriptionCode(data) ?? null,
          dataStatus: data.status ?? null,
        },
      );
      break;
    }
  }
}

router.post('/', paystackIpAllowlist, express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['x-paystack-signature'];
  if (!sig || typeof sig !== 'string') {
    res.status(400).json({ error: 'Missing x-paystack-signature header' });
    return;
  }

  let event: PaystackWebhookEvent;
  try {
    event = verifyPaystackWebhook(req.body as Buffer, sig);
  } catch (err: any) {
    console.error('[Paystack webhook] Signature verification failed:', err.message);
    res.status(400).json({ error: `Webhook signature error: ${err.message}` });
    return;
  }

  // Idempotency must be per webhook occurrence. For repeated subscription events
  // like subscription.not_renew, subscription_code alone is not enough because the
  // same subscription can be cancelled/reactivated/cancelled again.
  // FIX-5: cancelledAt is included so two consecutive subscription.disable events on
  // the same subscription (cancel → reactivate → cancel) produce distinct keys even
  // when next_payment_date and status are identical. The customer_code fallback has
  // been removed — it caused all structurally-similar events for one customer to
  // collide on the same key, silently dropping the second event.
  const occurrenceKey = [
    event.data?.subscription_code,
    event.data?.next_payment_date,
    event.data?.status,
    event.data?.updatedAt,
    event.data?.createdAt,
    event.data?.cancelledAt ?? null,
  ].filter(Boolean).join('::');
  const externalKey =
    event.data?.reference
    ?? event.data?.id
    ?? event.data?.event_id
    ?? event.data?.invoice_code
    ?? event.data?.most_recent_invoice?.transaction_reference
    ?? (occurrenceKey || undefined)
    ?? JSON.stringify(event.data).slice(0, 120);
  const externalId = `${event.event}::${externalKey}`;

  try {
    await prisma.webhookEvent.create({
      data: {
        externalId,
        provider: 'paystack',
        eventType: event.event,
        responseStatus: 200,
      },
    });
  } catch (createErr: any) {
    if (createErr.code === 'P2002' || createErr.message?.includes('Unique constraint')) {
      // BUG-FIX-WEBHOOK-1: Do NOT blindly return 200 here.
      // If the previous attempt for this externalId failed (responseStatus 500), Paystack
      // retried it legitimately. Returning 200 without re-processing poisoned every retry:
      // subscription.create was permanently skipped and subscription_code/email_token were
      // never stored — leaving every paid subscription stuck at INCOMPLETE forever.
      const existing = await prisma.webhookEvent.findUnique({
        where: { externalId },
        select: { responseStatus: true },
      }).catch(() => null);

      if (!existing || existing.responseStatus === 200) {
        // Genuinely already processed successfully — safe to treat as duplicate.
        console.log(`[Paystack webhook] Duplicate (already succeeded): ${externalId}`);
        res.json({ received: true, duplicate: true });
        return;
      }

      // Previous attempt failed. Reset the row so THIS retry can proceed.
      // If a concurrent process wins the update race we still fall through to processEvent.
      console.log(`[Paystack webhook] Retrying previously-failed event: ${externalId} (was ${existing.responseStatus})`);
      await prisma.webhookEvent.update({
        where: { externalId },
        data: { responseStatus: 200, error: null, processedAt: new Date() },
      }).catch(() => {/* race: another process won — continue anyway */});
      // Fall through to processEvent below.
    } else {
      console.error('[Paystack webhook] Failed to create idempotency record:', createErr);
      // Do not return — allow processEvent to run even when idempotency write fails.
    }
  }

  try {
    await processEvent(event);
    res.json({ received: true });
  } catch (err: any) {
    console.error(`[Paystack webhook] Error processing ${event.event}:`, err);
    await prisma.webhookEvent.updateMany({
      where: { externalId },
      data: { responseStatus: 500, error: err.message ?? String(err) },
    }).catch(() => undefined);
    res.status(500).json({ received: false, error: err.message ?? 'Webhook processing failed' });
  }
});

export default router;
