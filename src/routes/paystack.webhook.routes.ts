/**
 * FLOWFIT — Paystack Webhook Handler
 *
 * FIXES IN THIS VERSION:
 *
 *   FIX-W3  subscription.create lookup was failing silently.
 *           Root cause A: Strategy 0 used data.most_recent_invoice?.transaction
 *           which is Paystack's NUMERIC internal transaction ID (e.g. 302961),
 *           not our custom paystackReference string (e.g. ff_abc_1234567890).
 *           The query ran, found nothing, and fell through — without any log
 *           warning — because invoiceTxRef was truthy. Removed.
 *
 *           Root cause B: No lookup by paystackCustomerCode even though we
 *           store it on the INCOMPLETE row at checkout creation and Paystack
 *           always includes customer.customer_code in subscription.create.
 *           This is now Strategy 0 — the most reliable link available.
 *
 *           Root cause C: Strategy 3 searched for status:'INCOMPLETE', but by
 *           the time subscription.create fires (~3-5 min after payment),
 *           charge.success has already set status to 'ACTIVE'. Dead strategy.
 *           Replaced with a broader status filter that matches what actually
 *           exists in the DB at that point.
 *
 *   FIX-W4  subscription.create now also activates the subscription row when
 *           its status is still INCOMPLETE at the time the event fires. This
 *           covers the rare case where subscription.create arrives before
 *           charge.success (Paystack event order is not guaranteed).
 *
 *   FIX-W5  Removed fire-and-forget webhook background code fetches.
 *           Serverless runtimes can freeze them immediately after response.
 *           subscription.create remains the authoritative source for
 *           subscription_code/email_token, while charge.success only grants
 *           ACTIVE entitlement.
 *
 * All other logic, idempotency, and DB patterns are unchanged.
 */

import { Router, Request, Response }   from 'express';
import { SubscriptionStatus, BillingInterval } from '@prisma/client';
import prisma                           from '../config/db.js';
import {
  verifyPaystackWebhook,
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

// ─── Status mapping ───────────────────────────────────────────────────────────
const PAYSTACK_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active:         'ACTIVE',
  'non-renewing': 'ACTIVE',
  attention:      'PAST_DUE',
  completed:      'EXPIRED',
  cancelled:      'CANCELLED',
};

function mapPaystackStatus(ps: string): SubscriptionStatus {
  return PAYSTACK_STATUS_MAP[ps] ?? 'EXPIRED';
}


async function createPaystackPaymentIfMissing(tx: any, data: {
  subscriptionId: string;
  paystackReference: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
}) {
  const existing = await tx.payment.findFirst({
    where: { paystackReference: data.paystackReference },
    select: { id: true },
  });

  if (existing) return;

  await tx.payment.create({
    data: {
      subscriptionId:    data.subscriptionId,
      paystackReference: data.paystackReference,
      amountCents:       data.amountCents,
      currency:          data.currency,
      status:            'succeeded',
      paidAt:            data.paidAt,
      provider:          'PAYSTACK',
    },
  });
}

// ─── Core webhook processor ───────────────────────────────────────────────────
async function processEvent(event: PaystackWebhookEvent): Promise<void> {
  const { data } = event;

  switch (event.event) {

    // ── First payment / renewal ───────────────────────────────────────────────
    case 'charge.success': {
      const reference = data.reference as string;
      const meta      = (data.metadata ?? {}) as Record<string, any>;
      const userId    = meta.userId   as string | undefined;
      const planId    = meta.planId   as string | undefined;
      const interval  = (meta.interval ?? 'MONTHLY') as BillingInterval;

      // FIX-CODES-2 (preserved): extract as `let` at top scope so they are
      // visible and mutable inside the $transaction callback below.
      // Paystack does NOT include subscription_code / email_token in the
      // first-payment charge.success — they only arrive in subscription.create.
      // These will be undefined here for all first-payment events, which is
      // correct — undefined causes Prisma to skip the field (leave null),
      // and subscription.create will fill them in later.
      let subscriptionCode: string | undefined =
        data.subscription?.subscription_code ?? data.subscription_code ?? undefined;
      let emailToken: string | undefined =
        data.subscription?.email_token ?? data.email_token ?? undefined;

      if (!reference) {
        console.warn('[Webhook] charge.success: no reference in event data');
        return;
      }

      // ── Lookup: find the right subscription row ───────────────────────────
      //
      // Strategy 0 (most reliable): direct lookup by subscriptionId embedded in
      // Paystack metadata. This is set in createCheckoutSession (FIX-CODES-1 in
      // subscription.service.ts) — the INCOMPLETE row is created BEFORE the
      // Paystack transaction is initialised, so subscriptionId is always in
      // metadata for new subscriptions.
      const metaSubscriptionId = meta.subscriptionId as string | undefined;
      let existing = metaSubscriptionId
        ? await prisma.subscription.findFirst({
            where: { id: metaSubscriptionId, status: 'INCOMPLETE' },
          })
        : null;

      // Strategy 1: find INCOMPLETE row by reference
      if (!existing) {
        existing = await prisma.subscription.findFirst({
          where:   { paystackReference: reference, status: 'INCOMPLETE' },
          orderBy: { createdAt: 'desc' },
        });
      }

      // Strategy 2: find by userId + planId from metadata
      if (!existing && userId && planId) {
        existing = await prisma.subscription.findFirst({
          where:   { userId, planId, status: 'INCOMPLETE' },
          orderBy: { createdAt: 'desc' },
        });
      }

      const isRenewal = !existing;

      // ── Period end ────────────────────────────────────────────────────────
      // FIX-W2 (preserved): derive nextPaymentDate from interval when Paystack
      // omits next_payment_date, so currentPeriodEnd is always in the future.
      const now = new Date();
      let nextPaymentDate: Date | null = null;
      if (data.subscription?.next_payment_date) {
        nextPaymentDate = new Date(data.subscription.next_payment_date as string);
      } else {
        nextPaymentDate = new Date(now);
        if (interval === 'YEARLY') {
          nextPaymentDate.setFullYear(nextPaymentDate.getFullYear() + 1);
        } else {
          nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
        }
      }

      if (!userId || !planId) {
        if (!existing) {
          console.warn('[Webhook] charge.success: missing userId/planId in metadata and no INCOMPLETE row found. reference:', reference);
          return;
        }
      }

      await prisma.$transaction(async (tx) => {
        if (existing && (existing.status === 'INCOMPLETE' || existing.status === 'TRIALING')) {
          // ── First payment: activate the INCOMPLETE / free-trial row ─────────
          // FIX-CODES-2 (preserved): fall back to any value already in the DB.
          // subscriptionCode and emailToken are undefined on first-payment
          // charge.success — undefined → Prisma skips the field → stays null.
          // subscription.create (FIX-W3) will write the real values shortly.
          subscriptionCode = subscriptionCode ?? existing.paystackSubscriptionCode ?? undefined;
          emailToken       = emailToken       ?? existing.paystackEmailToken       ?? undefined;

          console.log(`[Webhook] charge.success: activating sub ${existing.id}`, {
            reference,
            subscriptionCode: subscriptionCode ?? '(absent — subscription.create will fill)',
            emailToken:       emailToken       ?? '(absent — subscription.create will fill)',
          });

          const effectivePlanId = planId ?? existing.planId;

          await tx.subscription.update({
            where: { id: existing.id },
            data: {
              status:                   'ACTIVE',
              provider:                 'PAYSTACK',
              interval,
              planId:                   effectivePlanId,
              paystackSubscriptionCode: subscriptionCode,   // undefined → Prisma skips, stays null
              paystackEmailToken:       emailToken,          // undefined → Prisma skips, stays null
              paystackReference:        reference,
              currentPeriodStart:       now,
              currentPeriodEnd:         nextPaymentDate,
              activatedAt:              now,
              cancelAtPeriodEnd:        false,
            },
          });

          await createPaystackPaymentIfMissing(tx, {
            subscriptionId:    existing.id,
            paystackReference: reference,
            amountCents:       data.amount as number,
            currency:          ((data.currency as string) ?? 'KES').toUpperCase(),
            paidAt:            now,
          });

          await tx.subscriptionLog.create({
            data: {
              subscriptionId: existing.id,
              event:          'ACTIVATED',
              previousStatus: existing.status,
              newStatus:      'ACTIVE',
              metadata: { paystackReference: reference, note: 'first_payment_charge_success' },
            },
          });

        } else {
          // ── Renewal: find ACTIVE sub by subscription code ─────────────────
          const resolvedUserId = userId ?? existing?.userId;
          const sub = subscriptionCode
            ? await tx.subscription.findFirst({
                where:   { paystackSubscriptionCode: subscriptionCode },
                include: { plan: true },
              })
            : resolvedUserId
              ? await tx.subscription.findFirst({
                  where:   { userId: resolvedUserId, status: 'ACTIVE', provider: 'PAYSTACK' },
                  include: { plan: true },
                  orderBy: { createdAt: 'desc' },
                })
              : null;

          if (!sub) {
            const resolvedPlanId = planId ?? existing?.planId;
            if (!resolvedUserId || !resolvedPlanId) {
              console.warn('[Webhook] charge.success renewal: cannot create sub — missing userId/planId. reference:', reference);
              return;
            }
            console.warn(
              `[Webhook] charge.success renewal: no active subscription found for code ${subscriptionCode}. ` +
              `Creating from Paystack data for userId=${resolvedUserId}.`,
            );
            const created = await tx.subscription.create({
              data: {
                userId:                   resolvedUserId,
                planId:                   resolvedPlanId,
                status:                   'ACTIVE',
                provider:                 'PAYSTACK',
                interval,
                paystackSubscriptionCode: subscriptionCode ?? null,
                paystackEmailToken:       emailToken       ?? null,
                paystackReference:        reference,
                currentPeriodStart:       now,
                currentPeriodEnd:         nextPaymentDate,
                activatedAt:              now,
              },
            });
            await createPaystackPaymentIfMissing(tx, {
              subscriptionId:    created.id,
              paystackReference: reference,
              amountCents:       data.amount as number,
              currency:          ((data.currency as string) ?? 'KES').toUpperCase(),
              paidAt:            now,
            });
            await tx.subscriptionLog.create({
              data: {
                subscriptionId: created.id,
                event:          'ACTIVATED',
                previousStatus: null,
                newStatus:      'ACTIVE',
                metadata: { paystackReference: reference, note: 'created_from_webhook_fallback' },
              },
            });
            return;
          }

          const prevStatus = sub.status;
          let appliedPlanId: string | undefined;
          if (sub.scheduledPlanId) appliedPlanId = sub.scheduledPlanId;

          await tx.subscription.update({
            where: { id: sub.id },
            data: {
              status:             'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd:   nextPaymentDate,
              cancelAtPeriodEnd:  false,
              paystackEmailToken: emailToken ?? sub.paystackEmailToken,
              activatedAt:        prevStatus !== 'ACTIVE' ? now : undefined,
              planId:             appliedPlanId ?? sub.planId,
              scheduledPlanId:    appliedPlanId ? null : undefined,
              scheduledInterval:  appliedPlanId ? null : undefined,
            },
          });

          await createPaystackPaymentIfMissing(tx, {
            subscriptionId:    sub.id,
            paystackReference: reference,
            amountCents:       data.amount as number,
            currency:          ((data.currency as string) ?? 'KES').toUpperCase(),
            paidAt:            now,
          });

          await tx.subscriptionLog.create({
            data: {
              subscriptionId: sub.id,
              event:          appliedPlanId ? 'DOWNGRADE_APPLIED' : 'PAYMENT_SUCCEEDED',
              previousStatus: prevStatus,
              newStatus:      'ACTIVE',
              metadata: { paystackReference: reference, amountCents: data.amount },
            },
          });

          const planName    = (sub as any).plan?.name ?? 'your plan';
          const nextDateStr = nextPaymentDate
            ? nextPaymentDate.toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
            : '';
          notifySubRenewed(sub.userId, planName, nextDateStr)
            .catch(err => console.error('[Webhook] renewal notification failed:', err));
        }
      });

      // ── Notify first-payment user ─────────────────────────────────────────
      if (!isRenewal && existing) {
        const notifyUserId = userId ?? existing.userId;
        const notifyPlanId = planId ?? existing.planId;
        (async () => {
          try {
            const plan = await prisma.plan.findUnique({ where: { id: notifyPlanId }, select: { name: true } });
            await notifySubActivated(notifyUserId, plan?.name ?? 'Premium', 'PAYSTACK');
          } catch (err) {
            console.error('[Webhook] charge.success notification failed:', err);
          }
        })();
      }

      // Paystack management codes are stored by subscription.create.
      // Do not start background retries from webhooks on serverless runtimes.

      break;
    }

    // ── Subscription created ──────────────────────────────────────────────────
    // Fires when Paystack creates the Subscription object after the first
    // successful charge. This is the authoritative source of
    // subscription_code and email_token — storing them here is the primary fix.
    //
    // FIX-W3: Rewrote all lookup strategies. See module-level comment.
     
      // ── Trial-started notification ────────────────────────────────────────
      case 'subscription.create': {
  const subCode    = data.subscription_code as string | undefined;
  const emailToken = data.email_token        as string | undefined;
  const custEmail  = data.customer?.email         as string | undefined;
  const customerCode = data.customer?.customer_code as string | undefined;

  console.log('[Webhook] subscription.create received', {
    subCode,
    hasEmailToken: !!emailToken,
    custEmail,
    customerCode,
  });

  if (!subCode) {
    console.warn('[Webhook] subscription.create: no subscription_code — skipping');
    break;
  }
  if (!emailToken) {
    console.warn('[Webhook] subscription.create: no email_token — skipping');
    break;
  }

  let dbSub: Awaited<ReturnType<typeof prisma.subscription.findFirst>> = null;

  // Strategy 0: by paystackCustomerCode (most reliable — set on INCOMPLETE row at checkout)
  if (customerCode) {
    dbSub = await prisma.subscription.findFirst({
      where: {
        paystackCustomerCode: customerCode,
        status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      orderBy: { updatedAt: 'desc' },   // updatedAt: charge.success would have just touched this row
    });
    console.log(
      dbSub
        ? `[Webhook] subscription.create: Strategy 0 found sub ${dbSub.id} via customerCode`
        : `[Webhook] subscription.create: Strategy 0 found NOTHING for customerCode=${customerCode}`,
    );
  }

  // Strategy 1: by subscription code already stored (renewal case)
  if (!dbSub) {
    dbSub = await prisma.subscription.findFirst({
      where:   { paystackSubscriptionCode: subCode },
      orderBy: { createdAt: 'desc' },
    });
    if (dbSub) console.log(`[Webhook] subscription.create: Strategy 1 found sub ${dbSub.id} via subCode`);
  }

  // Strategy 2: by customer email → user → most recent active sub
  if (!dbSub && custEmail) {
    const user = await prisma.user.findUnique({
      where:  { email: custEmail },
      select: { id: true },
    });
    if (user) {
      dbSub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING', 'PAST_DUE'] },
          provider: 'PAYSTACK',
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (dbSub) console.log(`[Webhook] subscription.create: Strategy 2 found sub ${dbSub.id} via custEmail`);
    }
  }

  // Strategy 3: by paystackReference — charge.success stores it when activating
  if (!dbSub && data.most_recent_invoice?.transaction_reference) {
    const ref = data.most_recent_invoice.transaction_reference as string;
    dbSub = await prisma.subscription.findFirst({
      where: { paystackReference: ref },
      orderBy: { createdAt: 'desc' },
    });
    if (dbSub) console.log(`[Webhook] subscription.create: Strategy 3 found sub ${dbSub.id} via reference`);
  }

  if (!dbSub) {
    console.error(
      '[Webhook] subscription.create: ❌ NO matching subscription found after all strategies.',
      { subCode, customerCode, custEmail },
      '— paystackSubscriptionCode and paystackEmailToken will NOT be stored.',
      'Check that paystackCustomerCode is set on the subscription row at checkout.',
    );
    break;
  }

  // FIX-W4: Activate if charge.success hasn't fired yet
  const now = new Date();
  const activationPatch: Record<string, unknown> = {};
  if (dbSub.status === 'INCOMPLETE') {
    const nextPeriodEnd = new Date(now);
    if (dbSub.interval === 'YEARLY') {
      nextPeriodEnd.setFullYear(nextPeriodEnd.getFullYear() + 1);
    } else {
      nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
    }
    activationPatch.status             = 'ACTIVE';
    activationPatch.activatedAt        = now;
    activationPatch.currentPeriodStart = now;
    activationPatch.currentPeriodEnd   = nextPeriodEnd;
    activationPatch.cancelAtPeriodEnd  = false;
    console.log(`[Webhook] subscription.create: sub ${dbSub.id} is INCOMPLETE — activating now`);
  }

  try {
    await prisma.subscription.update({
      where: { id: dbSub.id },
      data: {
        // Use || not ?? so empty string is also replaced
        paystackSubscriptionCode: subCode      || dbSub.paystackSubscriptionCode || null,
        paystackEmailToken:       emailToken   || dbSub.paystackEmailToken       || null,
        // Backfill customerCode if missing
        ...(customerCode && !dbSub.paystackCustomerCode
          ? { paystackCustomerCode: customerCode }
          : {}),
        ...activationPatch,
      },
    });

    console.log(
      `[Webhook] subscription.create: ✅ STORED codes for sub ${dbSub.id}`,
      { subCode, emailTokenLength: emailToken.length },
    );
  } catch (updateErr: any) {
    console.error(
      `[Webhook] subscription.create: ❌ DB UPDATE FAILED for sub ${dbSub.id}:`,
      updateErr?.message ?? updateErr,
    );
    throw updateErr; // re-throw so outer catch marks the webhook as failed
  }

  await prisma.subscriptionLog.create({
    data: {
      subscriptionId: dbSub.id,
      event:          'WEBHOOK_RECEIVED',
      previousStatus: dbSub.status,
      newStatus:      (activationPatch.status as any) ?? dbSub.status,
      metadata: {
        webhookEvent:             'subscription.create',
        paystackSubscriptionCode: subCode,
        hasEmailToken:            !!emailToken,
      },
    },
  }).catch(err => console.warn('[Webhook] subscription.create log write failed (non-fatal):', err));

  if (dbSub.trialEndsAt && dbSub.trialEndsAt > now) {
    const plan = await prisma.plan.findUnique({
      where:  { id: dbSub.planId },
      select: { name: true, trialDays: true },
    });
    const daysLeft = Math.max(1, Math.ceil((dbSub.trialEndsAt.getTime() - Date.now()) / 86_400_000));
    notifyTrialStarted(dbSub.userId, plan?.name ?? 'Premium', daysLeft)
      .catch(err => console.error('[Webhook] trial_started notification failed:', err));
  }

  break;
      }

    // ── Subscription disabled (cancelled) ─────────────────────────────────────
    case 'subscription.disable': {
      const subCode = data.subscription_code as string | undefined;
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({
        where:   { paystackSubscriptionCode: subCode },
        include: { plan: true },
      });
      if (!sub) return;

      const prevStatus = sub.status;

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status:      'CANCELLED',
            cancelledAt: new Date(),
          },
        });
        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'CANCELLED',
            previousStatus: prevStatus,
            newStatus:      'CANCELLED',
            metadata: { paystackSubCode: subCode },
          },
        });
      });

      const planName = (sub as any).plan?.name ?? 'your plan';
      notifySubCancelled(sub.userId, planName, '', true)
        .catch(err => console.error('[Webhook] sub_disabled notification failed:', err));

      break;
    }

    // ── Subscription set to not renew ─────────────────────────────────────────
    case 'subscription.not_renew': {
      const subCode     = data.subscription_code as string | undefined;
      const nextPayment = data.next_payment_date  as string | undefined;
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({
        where:   { paystackSubscriptionCode: subCode },
        include: { plan: true },
      });
      if (!sub) return;

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            cancelAtPeriodEnd: true,
            autoRenew:         false,
          },
        });
        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'CANCEL_SCHEDULED',
            previousStatus: sub.status,
            newStatus:      sub.status,
            metadata: { paystackSubCode: subCode, nextPaymentDate: nextPayment },
          },
        });
      });

      const endDateStr = nextPayment
        ? new Date(nextPayment).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
      notifySubCancelled(sub.userId, (sub as any).plan?.name ?? 'your plan', endDateStr, false)
        .catch(err => console.error('[Webhook] not_renew notification failed:', err));

      break;
    }

    // ── Invoice payment failed ────────────────────────────────────────────────
    case 'invoice.payment_failed': {
      const subCode   = data.subscription?.subscription_code as string | undefined;
      const reference = data.reference                        as string | undefined;
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({
        where:   { paystackSubscriptionCode: subCode },
        include: { plan: true },
      });
      if (!sub) return;

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data:  { status: 'PAST_DUE' },
        });
        await tx.payment.create({
          data: {
            subscriptionId:    sub.id,
            paystackReference: reference ?? null,
            amountCents:       Number(data.amount ?? 0),
            currency:          String(data.currency ?? 'KES').toUpperCase(),
            status:            'failed',
            provider:          'PAYSTACK',
            failureMessage:    (data.gateway_response as string) ?? null,
          },
        });
        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'PAYMENT_FAILED',
            previousStatus: sub.status,
            newStatus:      'PAST_DUE',
            metadata: { paystackSubCode: subCode, reference },
          },
        });
      });

      notifyPaymentFailed(sub.userId, (sub as any).plan?.name ?? 'your plan')
        .catch(err => console.error('[Webhook] payment_failed notification failed:', err));

      break;
    }

    // ── Expiring cards ────────────────────────────────────────────────────────
    case 'subscription.expiring_cards': {
      const subCode = data.subscription_code as string | undefined;
      if (!subCode) return;

      const sub = await prisma.subscription.findFirst({
        where:   { paystackSubscriptionCode: subCode },
        include: { plan: true },
      });
      if (!sub) return;

      if (sub.status === 'TRIALING' && sub.trialEndsAt) {
        const msLeft   = sub.trialEndsAt.getTime() - Date.now();
        const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
        notifyTrialEnding(sub.userId, (sub as any).plan?.name ?? 'your plan', daysLeft)
          .catch(err => console.error('[Webhook] trial_ending notification failed:', err));
      }

      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event:          'RENEWAL_REMINDER_SENT',
          previousStatus: sub.status,
          newStatus:      sub.status,
          metadata: { paystackSubCode: subCode },
        },
      });

      break;
    }

    default:
      break;
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────
router.post(
  '/',
  async (req: Request, res: Response) => {
    const sig = req.headers['x-paystack-signature'];
    if (!sig || typeof sig !== 'string') {
      res.status(400).json({ error: 'Missing x-paystack-signature header' });
      return;
    }

    let event: PaystackWebhookEvent;
    try {
      event = verifyPaystackWebhook(req.body as Buffer, sig);
    } catch (err: any) {
      console.error('[Webhook] Signature verification failed:', err.message);
      res.status(400).json({ error: `Webhook signature error: ${err.message}` });
      return;
    }

    // Idempotency key: event type + reference/subscription_code/id
    const reference  = event.data?.reference
                    ?? event.data?.subscription_code
                    ?? event.data?.id
                    ?? `${Date.now()}`;
    const externalId = `${event.event}::${reference}`;

    try {
      await prisma.webhookEvent.create({
        data: {
          externalId,
          provider:       'paystack',
          eventType:      event.event,
          responseStatus: 200,
        },
      });
    } catch (createErr: any) {
      if (createErr.code === 'P2002' || createErr.message?.includes('Unique constraint')) {
        res.json({ received: true, duplicate: true });
        return;
      }
      console.error('[Webhook] Failed to create idempotency record:', createErr);
      res.json({ received: true });
      return;
    }

    let processingError: string | null = null;
    try {
      await processEvent(event);
    } catch (err: any) {
      console.error(`[Webhook] Error processing ${event.event}:`, err);
      processingError = err.message;
    }

    if (processingError) {
      await prisma.webhookEvent.update({
        where: { externalId },
        data:  { responseStatus: 207, error: processingError },
      }).catch(e => console.error('[Webhook] Failed to update event status:', e));
    }

    // Always return 200 — Paystack retries on non-200.
    res.json({ received: true });
  },
);

export default router;
