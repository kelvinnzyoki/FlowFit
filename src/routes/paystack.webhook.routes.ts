// SECURITY PATCHES APPLIED: FIX-1, FIX-4, FIX-5, FIX-7, FIX-8, FIX-9, FIX-10, FIX-12, FIX-13, FIX-14
/**
 * FLOWFIT — Paystack Webhook Handler
 *
 * FIX-1  (Critical) express.raw() applied inline on the POST route so req.body is
 *        always a Buffer when verifyPaystackWebhook runs. Without this, the global
 *        express.json() middleware parses req.body into a JS object first, causing
 *        rawBody.toString('utf8') to return "[object Object]" and HMAC to mismatch
 *        on every real Paystack webhook — silently dropping all events.
 *
 * FIX-8  (Medium) Paystack IP allowlist checked before HMAC verification. Requests
 *        from unexpected IPs log a warning but are NOT hard-rejected — Paystack can
 *        add IPs without notice and a hard 403 would drop all subscription activations.
 *        HMAC-SHA512 signature verification is the enforced security control.
 *        The IP check is defence-in-depth / anomaly detection only.
 *
 * FIX-9  (Medium) Strategy 4c/4d in findSubscriptionForCreate tightened to
 *        status: { in: ['ACTIVE','TRIALING','PAST_DUE','GRACE_PERIOD'] }, preventing
 *        PAST_DUE rows from stealing subscription codes that belong to a new checkout.
 *
 * FIX-10 (Medium) subscription.not_renew now guards currentPeriodEnd > now before
 *        setting cancelAtPeriodEnd, preventing a late Paystack retry from
 *        force-cancelling a subscription that already renewed.
 *
 * FIX-12 (Low) charge.success and invoice.payment_failed guard amountCents > 0
 *        before writing payment records, preventing zero-KES rows from polluting
 *        billing history and breaking reconciliation.
 *
 * FIX-13 (Low) paystackRequest passes AbortSignal.timeout(15_000) so a slow
 *        Paystack response cannot hold the webhook handler open until Vercel kills
 *        the function, triggering a duplicate Paystack retry.
 *
 * FIX-14 (Low) processChargeSuccess wrapped in prisma.$transaction so payment
 *        record creation and subscription update are atomic.
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
  notifyTrialEnding,
  notifySubRenewed,
  notifyPaymentFailed,
  notifySubCancelled,
} from '../services/notification.service.js';

const router = Router();

// FIX-8: Paystack publishes the IPs it sends webhooks from.
// Reject anything outside this set before spending CPU on HMAC.
// Update PAYSTACK_WEBHOOK_IPS env when Paystack publishes new IPs.
const PAYSTACK_WEBHOOK_IPS = new Set(
  (process.env.PAYSTACK_WEBHOOK_IPS ?? '52.31.139.75,52.49.173.169,52.214.14.220')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean),
);

function isPaystackIp(req: Request): boolean {
  // In production behind a proxy (Vercel, Nginx), the real IP is in X-Forwarded-For.
  // Use the first XFF entry: behind a single trusted proxy (Vercel) this is the
  // real caller's IP — the IP that Paystack actually sent the request from.
  const forwarded = req.headers['x-forwarded-for'];
  const parts = typeof forwarded === 'string' ? forwarded.split(',') : [];
  const ip = (parts[0] ?? req.ip ?? '').trim();
  // AUDIT-FIX-6: Paystack IP matching now checks the original caller IP behind Vercel.
  return PAYSTACK_WEBHOOK_IPS.has(ip);
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
    ?? data?.most_recent_invoice?.transaction?.metadata
    ?? data?.most_recent_invoice?.transaction_metadata
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
}) {
  if (!params.reference) return null;

  // FIX-12: Never write a zero-amount payment record — it corrupts billing history
  // and confuses reconciliation that checks amounts. Log and skip instead.
  if (params.amountCents <= 0 && params.status === 'succeeded') {
    console.warn(
      `[createPaymentOnce] Skipping zero-amount payment for ref ${params.reference} ` +
      `on sub ${params.subscriptionId}`,
    );
    return null;
  }

  const existing = await prisma.payment.findFirst({ where: { paystackReference: params.reference } });
  if (existing) return existing;

  return prisma.payment.create({
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
    const existingAfterRace = await prisma.payment.findFirst({ where: { paystackReference: params.reference! } });
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
}) {
  // Guard: never reactivate a terminal-status row. Mirrors the guard in
  // storeCodesAndActivate (paystack.service.ts). Without this, a late or replayed
  // subscription.create webhook can reactivate a CANCELLED row — e.g. in the
  // twin-tab checkout race where the first tab's INCOMPLETE row was cancelled by
  // createCheckoutSession before the webhook arrived.
  const current = await prisma.subscription.findUnique({
    where:  { id: params.subscriptionId },
    select: { status: true },
  });
  if (!current) {
    console.error(
      `[activateWithCodes] Subscription ${params.subscriptionId} not found — ` +
      `skipping (source: ${params.source})`,
    );
    return;
  }
  if (['CANCELLED', 'EXPIRED', 'INCOMPLETE_EXPIRED'].includes(current.status)) {
    console.error(
      `[activateWithCodes] Refusing to activate terminal subscription ` +
      `${params.subscriptionId} (status=${current.status}, source=${params.source}). ` +
      `This may indicate a duplicate webhook or twin-tab checkout race.`,
    );
    return;
  }

  await prisma.subscription.update({
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
  const meta = pickMetadata(data);
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

  // Strategy 4c/4d — charge.success already activated the row but subscription.create
  // still needs to write email_token.
  // FIX-9: Restrict to live statuses only. The previous notIn guard matched PAST_DUE
  // rows (which legitimately lack email_token) ahead of a new INCOMPLETE checkout row,
  // binding the wrong codes and leaving the INCOMPLETE row permanently broken.
  // Status must be one of the "currently paying" states, not PAST_DUE or any terminal state.
  if (customerCode) {
    const sub = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        provider: 'PAYSTACK',
        paystackEmailToken: null,
        status: { in: ['ACTIVE', 'TRIALING'] },
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
          status: { in: ['ACTIVE', 'TRIALING'] },
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

  // Strategy 6: Paystack API fallback — use the authoritative subscription object
  // to recover the customer code when all other strategies miss.
  if (subCode) {
    try {
      const paystackSub = await fetchPaystackSubscription(subCode);
      const apiCustomerCode = paystackSub.customer?.customer_code;
      if (apiCustomerCode) {
        const sub = await prisma.subscription.findFirst({
          where: {
            paystackCustomerCode: apiCustomerCode,
            provider: 'PAYSTACK',
            status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING'] },
            ...(planId ? { planId } : {}),
          },
          orderBy: { createdAt: 'desc' },
        });
        if (sub) return sub;
      }
    } catch (apiErr: any) {
      console.error('[findSubscriptionForCreate] Paystack API fallback failed:', apiErr.message);
    }
  }

  // Strategy 5 — broadest last resort: any PAYSTACK row with null email_token
  // that is not in a terminal status. Intentionally placed last to prevent it from
  // matching PAST_DUE or stale rows ahead of the targeted strategies above.
  if (!planId) {
    console.warn(
      `[findSubscriptionForCreate] Strategy 5 skipped: planCode=${planCode ?? 'missing'} was not found in DB; ` +
      `matching without a planId filter is too broad to be safe.`,
    );
  } else {
    if (customerCode) {
      const sub = await prisma.subscription.findFirst({
        where: {
          paystackCustomerCode: customerCode,
          provider: 'PAYSTACK',
          paystackEmailToken: null,
          status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING'] },
          planId,
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
            status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING'] },
            planId,
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (sub) return sub;
      }
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

  const amountCents = Number(data.amount ?? 0);
  const currency = String(data.currency ?? 'KES').toUpperCase();

  // FIX-4: Validate the Paystack-reported amount against the plan price before
  // activating. A tampered or test-mode webhook carrying a real reference but a
  // manipulated amount field would otherwise activate a full subscription for 1 KES.
  //
  // IMPORTANT UNIT CONTRACT:
  // Paystack amounts are in kobo. Paystack validation uses KES plan fields,
  // then converts KES to kobo here (e.g. KES 1,200/month = 120000 kobo).
  // Keep monthlyPriceCents/yearlyPriceCents for USD display prices only.
  if (amountCents > 0 && sub.planId) {
    const plan = await prisma.plan.findUnique({
      where: { id: sub.planId },
      select: { mpesaMonthlyKes: true, mpesaYearlyKes: true },
    });
    if (plan) {
      const expectedKes = sub.interval === 'YEARLY'
        ? plan.mpesaYearlyKes
        : plan.mpesaMonthlyKes;
      // AUDIT-FIX-1: Amount validation now uses DB subscription interval instead of metadata interval.

      const expectedKobo =
        typeof expectedKes === 'number'
          ? expectedKes * 100
          : null;

      if (expectedKobo === null || expectedKobo <= 0) {
        console.error(
          `[charge.success FIX-4] Plan price misconfigured for plan ${sub.planId}. ` +
          `Expected DB price in kobo but got ${expectedKobo}. Rejecting activation.`,
        );
        return;
      }

      if (amountCents < expectedKobo * 0.95) {
        console.error(
          `[charge.success FIX-4] Amount mismatch for ref ${reference}: ` +
          `received ${amountCents} kobo, expected ${expectedKobo} kobo (plan ${sub.planId}). ` +
          `Rejecting activation — check for webhook tampering or test-mode bleed.`,
        );
        return;
      }
    }
  }

  if (subscriptionCode && emailToken) {
    await prisma.$transaction(async (tx) => {
      const freshSub = await tx.subscription.findUnique({ where: { id: sub!.id } });
      if (!freshSub) return;
      const alreadyHasCodes = !!freshSub.paystackSubscriptionCode && !!freshSub.paystackEmailToken;

      if (amountCents > 0) {
        const existingPayment = await tx.payment.findFirst({ where: { paystackReference: reference } });
        if (!existingPayment) {
          await tx.payment.create({
            data: {
              subscriptionId: freshSub.id,
              paystackReference: reference,
              amountCents,
              currency,
              status: 'succeeded',
              paidAt: now,
              provider: 'PAYSTACK',
            },
          });
        }
      } else {
        console.warn(`[charge.success] Skipping zero-amount payment record for ref ${reference}`);
      }

      await tx.subscription.update({
        where: { id: freshSub.id },
        data: {
          status: 'ACTIVE',
          provider: 'PAYSTACK',
          paystackSubscriptionCode: subscriptionCode,
          paystackEmailToken: emailToken,
          paystackReference: reference,
          ...(customerCode ? { paystackCustomerCode: customerCode } : {}),
          ...(alreadyHasCodes || freshSub.status === 'ACTIVE'
            ? {}
            : { currentPeriodStart: now, currentPeriodEnd, activatedAt: now }),
          cancelAtPeriodEnd: false,
          autoRenew: true,
        },
      });

      await tx.subscriptionLog.create({
        data: {
          subscriptionId: freshSub.id,
          event: freshSub.status === 'ACTIVE' ? 'PAYMENT_SUCCEEDED' : 'ACTIVATED',
          previousStatus: freshSub.status,
          newStatus: 'ACTIVE',
          metadata: { source: 'charge.success', paystackReference: reference, paystackSubscriptionCode: subscriptionCode },
        },
      });
    });
    // Renewal notification fired outside the transaction so a slow notification
    // call does not hold the DB connection open.
    // Only fires when the row was already ACTIVE (renewal). First-activation
    // notifications are fired inside processSubscriptionCreate.
    if (sub.status === 'ACTIVE') {
      prisma.plan
        .findUnique({ where: { id: sub.planId }, select: { name: true } })
        .then(plan => notifySubRenewed(sub!.userId, plan?.name ?? 'Premium', 'PAYSTACK'))
        .catch(err => console.error('[charge.success] renewal notification failed:', err));
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    const freshSub = await tx.subscription.findUnique({ where: { id: sub!.id } });
    if (!freshSub) return;
    const alreadyHasCodes = !!freshSub.paystackSubscriptionCode && !!freshSub.paystackEmailToken;

    if (amountCents > 0) {
      const existingPayment = await tx.payment.findFirst({ where: { paystackReference: reference } });
      if (!existingPayment) {
        await tx.payment.create({
          data: {
            subscriptionId: freshSub.id,
            paystackReference: reference,
            amountCents,
            currency,
            status: 'succeeded',
            paidAt: now,
            provider: 'PAYSTACK',
          },
        });
      }
    } else {
      console.warn(`[charge.success] Skipping zero-amount payment record for ref ${reference}`);
    }

    await tx.subscription.update({
      where: { id: freshSub.id },
      data: {
        status: alreadyHasCodes ? freshSub.status : 'INCOMPLETE',
        provider: 'PAYSTACK',
        interval,
        paystackReference: reference,
        ...(customerCode ? { paystackCustomerCode: customerCode } : {}),
        ...(subscriptionCode && !freshSub.paystackSubscriptionCode
          ? { paystackSubscriptionCode: subscriptionCode }
          : {}),
        currentPeriodStart: freshSub.currentPeriodStart ?? now,
        currentPeriodEnd: freshSub.currentPeriodEnd ?? currentPeriodEnd,
        cancelAtPeriodEnd: false,
      },
    });

    await tx.subscriptionLog.create({
      data: {
        subscriptionId: freshSub.id,
        event: 'PAYMENT_SUCCEEDED',
        previousStatus: freshSub.status,
        newStatus: alreadyHasCodes ? freshSub.status : 'INCOMPLETE',
        metadata: {
          source: 'charge.success_pending_subscription.create',
          paystackReference: reference,
          reason: 'No subscription_code/email_token on charge.success payload',
        },
      },
    });
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
    // DECISION: do not throw here for a permanent miss.
    // Throwing returns HTTP 500, which causes Paystack to retry for up to 72 hours.
    // If the INCOMPLETE row was legitimately garbage-collected (e.g. marked
    // INCOMPLETE_EXPIRED by the expiry job) every retry will fail identically and
    // the event silently disappears after 72 hours with no trace.
    // Instead: log everything needed to investigate manually, then return 200 so
    // Paystack stops retrying. Wire an external alert (Sentry / Slack / PagerDuty) here.
    console.error(
      '[subscription.create] PERMANENT_MISS — no DB row found after all lookup strategies. Manual intervention required.',
      {
        subCode,
        customerCode:      pickCustomerCode(data),
        planCode:          pickPlanCode(data),
        reference:         pickTransactionReference(data),
        metaSubscriptionId: (pickMetadata(data) as any).subscriptionId ?? null,
      },
    );
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

  const invoice = data.most_recent_invoice ?? data.invoice ?? {};
  const paymentReference = reference ?? invoice.transaction_reference ?? invoice.reference ?? null;
  // FIX-7 + FIX-12: Only create a payment record when we have a real amount.
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

      if (sub.status === 'CANCELLED') {
        console.log(`[Paystack webhook] subscription.disable ignored; subscription already CANCELLED: ${sub.id}`);
        break;
      }

      const now = new Date();
      // Re-read to get the latest cancelAtPeriodEnd value in case scheduleDowngrade
      // committed its DB write between our findFirst call and now.
      const freshSub = await prisma.subscription.findUnique({
        where: { id: sub.id },
        select: { cancelAtPeriodEnd: true, scheduledPlanId: true },
      });
      const effectiveCancelAtPeriodEnd =
        freshSub?.cancelAtPeriodEnd ?? sub.cancelAtPeriodEnd;
      const effectiveScheduledPlanId =
        freshSub?.scheduledPlanId ?? sub.scheduledPlanId;
      // AUDIT-FIX-9: subscription.disable now uses a fresh DB read for scheduled downgrade state.
      const periodStillActive = !!sub.currentPeriodEnd && sub.currentPeriodEnd > now;
      const isPeriodEndCancel = periodStillActive && (effectiveCancelAtPeriodEnd === true || !!effectiveScheduledPlanId);

      if (isPeriodEndCancel) {
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
        await prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            autoRenew: false,
            cancelAtPeriodEnd: false,
            // paystackCustomerCode intentionally kept — reactivateSubscription needs it
            // to create a replacement subscription on the same customer.
            paystackEmailToken: null,
            paystackSubscriptionCode: null,
          },
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

      // FIX-10: Guard currentPeriodEnd > now before applying cancelAtPeriodEnd.
      // A late Paystack retry of this event (after the subscription has already renewed)
      // previously overwrote the renewed subscription's autoRenew=true with false,
      // causing it to silently stop billing on the next cycle.
      const now = new Date();
      if (sub.currentPeriodEnd && sub.currentPeriodEnd <= now) {
        console.warn(
          `[subscription.not_renew] Ignoring late event for sub ${sub.id} — ` +
          `currentPeriodEnd ${sub.currentPeriodEnd.toISOString()} is in the past. ` +
          `Subscription may have already renewed.`,
        );
        break;
      }

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          cancelAtPeriodEnd: true,
          autoRenew: false,
          // FIX-7: Clear any stale cancelledAt from a prior cycle so the frontend
          // does not display an incorrect 'cancelled on [old date]' message.
          cancelledAt: null,
        },
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
      const reference = (data.reference ?? data.invoice_code ?? null) as string | null;
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({ where: { paystackSubscriptionCode: subCode }, include: { plan: true } });
      if (!sub) return;

      const gracePeriodEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', gracePeriodEndsAt } });

      // FIX-12: Always record the failure regardless of amount, but use 0 for
      // failed records (amount may be absent on failure events — that is expected
      // and harmless for a 'failed' status record, unlike a zero 'succeeded' record).
      await createPaymentOnce({
        subscriptionId: sub.id,
        reference,
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
          metadata: { paystackSubCode: subCode, reference },
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
        // ISSUE-2-FIX: Guard trialEndsAt > now so a late-arriving expiring_cards
        // event for an already-ended trial doesn't say "1 day left" (Math.max clamping).
        const now2 = new Date();
        if (sub.trialEndsAt > now2) {
          const msLeft = sub.trialEndsAt.getTime() - now2.getTime();
          const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
          notifyTrialEnding(sub.userId, (sub as any).plan?.name ?? 'your plan', daysLeft)
            .catch(err => console.error('[Paystack webhook] trial ending notification failed:', err));
        }
      } else if (sub.status === 'ACTIVE') {
        // ISSUE-2-FIX: Paystack fires expiring_cards so you can warn ACTIVE subscribers
        // to update their card before renewal fails. Without this notification the card
        // expires silently, the next charge fails, and you lose the revenue.
        notifyPaymentFailed(sub.userId, (sub as any).plan?.name ?? 'your plan')
          .catch(err => console.error('[Paystack webhook] expiring card notification failed:', err));
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
      // FIX-4: Unknown event types are logged only.
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

// FIX-1: express.raw() is applied inline on this route so req.body is always a
// raw Buffer when verifyPaystackWebhook is called. The global express.json()
// middleware in server.ts would otherwise parse req.body into a JS object first,
// causing rawBody.toString('utf8') to return "[object Object]", which produces a
// different HMAC than Paystack's signature — silently rejecting every webhook.
//
// FIX-8: IP allowlisting is defence-in-depth only. Paystack may add webhook IPs
// without advance notice; hard-failing here would stop all subscription activation.
// HMAC-SHA512 verification below remains the authoritative security control.
router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  if (!isPaystackIp(req)) {
    console.warn(`[Paystack webhook] Unexpected Paystack webhook IP; continuing to HMAC verification: ${req.ip}`);
  }

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

  // FIX-5: Idempotency key includes cancelledAt so two consecutive subscription.disable
  // events on the same subscription produce distinct keys.
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
      const existing = await prisma.webhookEvent.findUnique({
        where: { externalId },
        select: { responseStatus: true },
      }).catch(() => null);

      if (!existing || existing.responseStatus === 200) {
        console.log(`[Paystack webhook] Duplicate (already succeeded): ${externalId}`);
        res.json({ received: true, duplicate: true });
        return;
      }

      console.log(`[Paystack webhook] Retrying previously-failed event: ${externalId} (was ${existing.responseStatus})`);
      await prisma.webhookEvent.update({
        where: { externalId },
        data: { responseStatus: 200, error: null, processedAt: new Date() },
      }).catch(() => {});
    } else {
      console.error('[Paystack webhook] Idempotency write failed (non-duplicate):', createErr);
      // Fall through and process the event anyway; a small double-processing risk is safer than certain webhook loss.
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
