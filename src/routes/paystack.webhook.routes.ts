/**
 * FLOWFIT — Paystack Webhook Handler (FINAL CORRECTED)
 *
 * Fixes the race war:
 * - charge.success records the payment but DOES NOT activate first-payment rows
 *   unless Paystack already supplied subscription_code + email_token.
 * - subscription.create is the authoritative event that stores the codes and
 *   activates the subscription.
 * - lookup order prioritizes metadata.subscriptionId and INCOMPLETE rows so old
 *   ACTIVE rows for the same customer cannot steal the new subscription.create.
 */

import { Router, Request, Response } from 'express';
import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import prisma from '../config/db.js';
import { verifyPaystackWebhook, PaystackWebhookEvent } from '../services/paystack.service.js';
import {
  notifySubActivated,
  notifyTrialStarted,
  notifyTrialEnding,
  notifySubRenewed,
  notifyPaymentFailed,
  notifySubCancelled,
} from '../services/notification.service.js';

const router = Router();

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
}) {
  if (params.reference) {
    const existing = await prisma.payment.findFirst({ where: { paystackReference: params.reference } });
    if (existing) return;
  }

  await prisma.payment.create({
    data: {
      subscriptionId: params.subscriptionId,
      paystackReference: params.reference ?? null,
      amountCents: params.amountCents,
      currency: params.currency,
      status: params.status,
      paidAt: params.paidAt ?? null,
      provider: 'PAYSTACK',
      failureMessage: params.failureMessage ?? null,
    },
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
}) {
  await prisma.subscription.update({
    where: { id: params.subscriptionId },
    data: {
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      paystackSubscriptionCode: params.subscriptionCode,
      paystackEmailToken: params.emailToken,
      ...(params.reference ? { paystackReference: params.reference } : {}),
      ...(params.customerCode ? { paystackCustomerCode: params.customerCode } : {}),
      currentPeriodStart: params.currentPeriodStart,
      currentPeriodEnd: params.currentPeriodEnd,
      activatedAt: params.previousStatus === 'ACTIVE' ? undefined : params.currentPeriodStart,
      cancelAtPeriodEnd: false,
      autoRenew: true,
    },
  });

  await prisma.subscriptionLog.create({
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
  const meta = (data.metadata ?? {}) as Record<string, any>;
  const metaSubscriptionId = meta.subscriptionId as string | undefined;
  const subCode = pickSubscriptionCode(data);
  const customerCode = pickCustomerCode(data);
  const customerEmail = pickCustomerEmail(data);
  const planCode = pickPlanCode(data);
  const planId = await findPlanIdByPaystackPlanCode(planCode);

  if (metaSubscriptionId) {
    const sub = await prisma.subscription.findUnique({ where: { id: metaSubscriptionId } });
    if (sub) return sub;
  }

  if (subCode) {
    const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode } });
    if (sub) return sub;
  }

  if (customerCode) {
    const incomplete = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        provider: 'PAYSTACK',
        status: 'INCOMPLETE',
        ...(planId ? { planId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (incomplete) return incomplete;

    const recent = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        provider: 'PAYSTACK',
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'GRACE_PERIOD'] },
        ...(planId ? { planId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (recent) return recent;
  }

  if (customerEmail) {
    const user = await prisma.user.findUnique({ where: { email: customerEmail }, select: { id: true } });
    if (user) {
      // Last safe fallback: only the user's own newest INCOMPLETE Paystack row.
      // Never attach subscription.create codes to ACTIVE/TRIALING/PAST_DUE rows by email,
      // because a user may already have another Paystack/M-Pesa subscription.
      const sub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          provider: 'PAYSTACK',
          status: 'INCOMPLETE',
          ...(planId ? { planId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (sub) return sub;
    }
  }

  return null;
}

async function processChargeSuccess(data: Record<string, any>): Promise<void> {
  const reference = data.reference as string | undefined;
  if (!reference) {
    console.warn('[Paystack webhook] charge.success without reference');
    return;
  }

  const meta = (data.metadata ?? {}) as Record<string, any>;
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

  if (!sub && userId && planId) {
    sub = await prisma.subscription.create({
      data: {
        userId,
        planId,
        status: 'INCOMPLETE',
        provider: 'PAYSTACK',
        interval,
        paystackReference: reference,
        paystackCustomerCode: customerCode ?? null,
        currentPeriodStart: now,
        currentPeriodEnd,
      },
    });
  }

  if (!sub) {
    console.error('[Paystack webhook] charge.success could not match/create subscription', { reference, userId, planId });
    return;
  }

  await createPaymentOnce({
    subscriptionId: sub.id,
    reference,
    amountCents: Number(data.amount ?? 0),
    currency: String(data.currency ?? 'KES').toUpperCase(),
    status: 'succeeded',
    paidAt: now,
  });

  if (subscriptionCode && emailToken) {
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
    });
    return;
  }

  // Payment succeeded, but Paystack has not provided management codes yet.
  // Keep it ACTIVE only if this row already had both management codes from an earlier
  // subscription.create event. Otherwise keep INCOMPLETE so the website does not unlock
  // before cancellation/reactivation/billing management can work.
  const alreadyHasCodes = !!sub.paystackSubscriptionCode && !!sub.paystackEmailToken;
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: alreadyHasCodes && sub.status === 'ACTIVE' ? 'ACTIVE' : 'INCOMPLETE',
      provider: 'PAYSTACK',
      interval,
      paystackReference: reference,
      ...(customerCode ? { paystackCustomerCode: customerCode } : {}),
      currentPeriodStart: now,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
    },
  });

  await prisma.subscriptionLog.create({
    data: {
      subscriptionId: sub.id,
      event: 'PAYMENT_SUCCEEDED',
      previousStatus: sub.status,
      newStatus: 'INCOMPLETE',
      metadata: {
        source: 'charge.success_pending_subscription.create',
        paystackReference: reference,
        reason: 'No subscription_code/email_token on charge.success payload',
      },
    },
  }).catch(() => undefined);
}

async function processSubscriptionCreate(data: Record<string, any>): Promise<void> {
  const subCode = pickSubscriptionCode(data);
  const emailToken = pickEmailToken(data);
  const customerCode = pickCustomerCode(data);
  const reference = data.most_recent_invoice?.transaction_reference
    ?? data.most_recent_invoice?.reference
    ?? data.reference
    ?? null;

  if (!subCode || !emailToken) {
    console.error('[Paystack webhook] subscription.create missing required codes', {
      hasSubCode: !!subCode,
      hasEmailToken: !!emailToken,
    });
    return;
  }

  const dbSub = await findSubscriptionForCreate(data);

  if (!dbSub) {
    console.error('[Paystack webhook] subscription.create could not find DB subscription', {
      subCode,
      customerCode,
      customerEmail: pickCustomerEmail(data),
      planCode: pickPlanCode(data),
    });
    return;
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

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), autoRenew: false },
      });

      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event: 'CANCELLED',
          previousStatus: sub.status,
          newStatus: 'CANCELLED',
          metadata: { paystackSubCode: subCode },
        },
      }).catch(() => undefined);

      notifySubCancelled(sub.userId, (sub as any).plan?.name ?? 'your plan', '', true)
        .catch(err => console.error('[Paystack webhook] cancellation notification failed:', err));
      break;
    }

    case 'subscription.not_renew': {
      const subCode = pickSubscriptionCode(data);
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode }, include: { plan: true } });
      if (!sub) return;

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
      await createPaymentOnce({
        subscriptionId: sub.id,
        reference: reference ?? null,
        amountCents: Number(data.amount ?? 0),
        currency: String(data.currency ?? 'KES').toUpperCase(),
        status: 'failed',
        failureMessage: (data.gateway_response as string) ?? null,
      });

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
      const subCode = pickSubscriptionCode(data);
      if (subCode) {
        const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode } });
        if (sub && data.status) {
          const newStatus = mapPaystackStatus(String(data.status));
          await prisma.subscription.update({ where: { id: sub.id }, data: { status: newStatus } }).catch(() => undefined);
        }
      }
      break;
    }
  }
}

router.post('/', async (req: Request, res: Response) => {
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
  const occurrenceKey = [
    event.data?.subscription_code,
    event.data?.next_payment_date,
    event.data?.status,
    event.data?.updatedAt,
    event.data?.createdAt,
  ].filter(Boolean).join('::');
  const externalKey = event.data?.reference
    ?? event.data?.id
    ?? event.data?.event_id
    ?? event.data?.invoice_code
    ?? event.data?.most_recent_invoice?.transaction_reference
    ?? (occurrenceKey || undefined)
    ?? event.data?.customer?.customer_code
    ?? JSON.stringify(event.data).slice(0, 80);
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
      res.json({ received: true, duplicate: true });
      return;
    }
    console.error('[Paystack webhook] Failed to create idempotency record:', createErr);
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
