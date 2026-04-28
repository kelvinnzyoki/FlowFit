/**
 * FLOWFIT — Paystack Webhook Handler
 *
 * Replaces webhook_routes.ts (Stripe) 1-for-1.
 * All business logic, idempotency, and DB patterns are identical.
 * Only the provider-specific verification and event shapes change.
 *
 * Paystack event → Stripe equivalent:
 *   charge.success          →  checkout.session.completed  (first payment)
 *                              invoice.payment_succeeded   (renewal)
 *   subscription.create     →  checkout.session.completed  (subscription created)
 *   subscription.disable    →  customer.subscription.deleted
 *   subscription.not_renew  →  customer.subscription.updated (cancel_at_period_end)
 *   invoice.payment_failed  →  invoice.payment_failed
 *   subscription.expiring_cards → customer.subscription.trial_will_end (cards only — no trial equivalent)
 *
 * Idempotency: identical atomic write-first pattern using webhookEvent.externalId unique constraint.
 * All webhook processing errors return HTTP 200 so Paystack does not retry endlessly.
 */

import { Router, Request, Response }  from 'express';
import { SubscriptionStatus, BillingInterval } from '@prisma/client';
import prisma                          from '../config/db.js';
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

// ─── Status mapping ───────────────────────────────────────────────────────────
// Paystack subscription statuses → our SubscriptionStatus enum
const PAYSTACK_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active:          'ACTIVE',
  'non-renewing':  'ACTIVE',    // still active — just won't renew; captured by cancelAtPeriodEnd
  attention:       'PAST_DUE',
  completed:       'EXPIRED',
  cancelled:       'CANCELLED',
};

function mapPaystackStatus(ps: string): SubscriptionStatus {
  return PAYSTACK_STATUS_MAP[ps] ?? 'EXPIRED';
}

// ─── Core webhook processor ───────────────────────────────────────────────────
async function processEvent(event: PaystackWebhookEvent): Promise<void> {
  const { data } = event;

  switch (event.event) {

    // ── First payment / checkout completed ────────────────────────────────────
    // Fires when the user completes the Paystack transaction initialisation.
    // data.plan is present when the charge is attached to a subscription plan.
    case 'charge.success': {
      // Skip non-subscription charges (one-off payments)
      if (!data.plan) return;

      const reference     = data.reference       as string;
      const subscriptionCode = data.subscription?.subscription_code as string | undefined;
      const emailToken    = data.subscription?.email_token         as string | undefined;
      const meta          = data.metadata ?? {};
      const userId        = meta.userId  as string | undefined;
      const planId        = meta.planId  as string | undefined;
      const interval      = (meta.interval ?? 'MONTHLY') as BillingInterval;
      const paystackSubId = meta.subscriptionId as string | undefined; // our INCOMPLETE row id

      if (!userId || !planId) {
        console.warn('[Webhook] charge.success: missing userId/planId in metadata, reference:', reference);
        return;
      }

      // Determine if this is a first payment (INCOMPLETE row exists) or a renewal
      const existing = paystackSubId
        ? await prisma.subscription.findUnique({ where: { id: paystackSubId } })
        : await prisma.subscription.findFirst({
            where: { userId, status: 'INCOMPLETE', planId },
            orderBy: { createdAt: 'desc' },
          });

      // Parse period boundaries from Paystack data
      const nextPaymentDate = data.subscription?.next_payment_date
        ? new Date(data.subscription.next_payment_date)
        : null;
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        if (existing && existing.status === 'INCOMPLETE') {
          // ── First payment: activate the INCOMPLETE row ─────────────────────
          await tx.subscription.update({
            where: { id: existing.id },
            data: {
              status:                   'ACTIVE',
              provider:                 'PAYSTACK',
              interval,
              paystackSubscriptionCode: subscriptionCode ?? null,
              paystackEmailToken:       emailToken       ?? null,
              currentPeriodStart:       now,
              currentPeriodEnd:         nextPaymentDate  ?? now,
              activatedAt:              now,
            },
          });

          await tx.payment.create({
            data: {
              subscriptionId:  existing.id,
              paystackReference: reference,
              amountCents:     data.amount as number,
              currency:        (data.currency as string ?? 'KES').toUpperCase(),
              status:          'succeeded',
              paidAt:          now,
            },
          });

          await tx.subscriptionLog.create({
            data: {
              subscriptionId: existing.id,
              event:          'ACTIVATED',
              previousStatus: 'INCOMPLETE',
              newStatus:      'ACTIVE',
              metadata: { paystackEventId: reference, note: 'first_payment' },
            },
          });
        } else {
          // ── Renewal: find by subscription code and update period ───────────
          const sub = subscriptionCode
            ? await tx.subscription.findFirst({
                where:   { paystackSubscriptionCode: subscriptionCode },
                include: { plan: true },
              })
            : null;

          if (!sub) {
            // Fallback: create from scratch (same defensive pattern as original Stripe handler)
            console.warn(
              `[Webhook] charge.success renewal: no subscription found for code ${subscriptionCode}. ` +
              `Creating from Paystack data for userId=${userId}.`,
            );
            const created = await tx.subscription.create({
              data: {
                userId,
                planId,
                status:                   'ACTIVE',
                provider:                 'PAYSTACK',
                interval,
                paystackSubscriptionCode: subscriptionCode ?? null,
                paystackEmailToken:       emailToken       ?? null,
                currentPeriodStart:       now,
                currentPeriodEnd:         nextPaymentDate  ?? now,
                activatedAt:              now,
              },
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

          // Check if a scheduled downgrade should be applied this renewal
          let appliedPlanId: string | undefined;
          if (sub.scheduledPlanId) {
            appliedPlanId    = sub.scheduledPlanId;
          }

          await tx.subscription.update({
            where: { id: sub.id },
            data: {
              status:            'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd:  nextPaymentDate ?? now,
              cancelAtPeriodEnd: false,
              paystackEmailToken: emailToken ?? sub.paystackEmailToken,
              activatedAt:       prevStatus !== 'ACTIVE' ? now : undefined,
              planId:            appliedPlanId ?? sub.planId,
              scheduledPlanId:   appliedPlanId ? null : undefined,
              scheduledInterval: appliedPlanId ? null : undefined,
            },
          });

          await tx.payment.create({
            data: {
              subscriptionId:    sub.id,
              paystackReference: reference,
              amountCents:       data.amount as number,
              currency:          (data.currency as string ?? 'KES').toUpperCase(),
              status:            'succeeded',
              paidAt:            now,
            },
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

          // ── Notify renewal ─────────────────────────────────────────────────
          const planName      = (sub as any).plan?.name ?? 'your plan';
          const nextDateStr   = nextPaymentDate
            ? nextPaymentDate.toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
            : '';
          notifySubRenewed(sub.userId, planName, nextDateStr)
            .catch(err => console.error('[Webhook] renewal notification failed:', err));
        }
      });

      // ── Notify first-payment user (fire-and-forget) ────────────────────────
      if (existing && existing.status === 'INCOMPLETE') {
        (async () => {
          try {
            const plan = await prisma.plan.findUnique({
              where:  { id: planId },
              select: { name: true, trialDays: true },
            });
            const planName = plan?.name ?? 'Premium';
            await notifySubActivated(userId, planName, 'PAYSTACK');
          } catch (err) {
            console.error('[Webhook] charge.success notification failed:', err);
          }
        })();
      }

      break;
    }

    // ── Subscription created ──────────────────────────────────────────────────
    // Paystack fires this when a subscription object is first created.
    // By this point charge.success has already run (or will run momentarily).
    // We use it to capture the subscription_code + email_token on the DB row
    // if not already set, without creating duplicate entries.
    case 'subscription.create': {
      const subCode   = data.subscription_code as string | undefined;
      const emailToken = data.email_token       as string | undefined;
      const custEmail = data.customer?.email    as string | undefined;
      const meta      = data.metadata ?? {};
      const userId    = meta.userId as string | undefined;

      if (!subCode || !userId) return;

      const dbSub = await prisma.subscription.findFirst({
        where:   { userId, status: { in: ['INCOMPLETE', 'ACTIVE'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!dbSub) return;

      // Persist subscription_code + email_token if not already done by charge.success
      if (!dbSub.paystackSubscriptionCode || !dbSub.paystackEmailToken) {
        await prisma.subscription.update({
          where: { id: dbSub.id },
          data: {
            paystackSubscriptionCode: subCode,
            paystackEmailToken:       emailToken ?? null,
          },
        });
      }

      // If the DB subscription has a trial period, fire the trial-started notification.
      // Paystack has no 'trialing' status — we use our own trialEndsAt to detect trials.
      if (dbSub.trialEndsAt && dbSub.trialEndsAt > new Date()) {
        const plan = await prisma.plan.findUnique({
          where:  { id: dbSub.planId },
          select: { name: true, trialDays: true },
        });
        const planName = plan?.name ?? 'Premium';
        const msLeft   = dbSub.trialEndsAt.getTime() - Date.now();
        const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
        notifyTrialStarted(userId, planName, daysLeft)
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
            // Paystack fires subscription.disable when a subscription is fully
            // cancelled (either the period ended after disable, or immediate cancel
            // from the dashboard). Do NOT set expiredAt here — the expiry job
            // uses currentPeriodEnd as the source of truth. Setting it to now()
            // would lock out users who still have days left in their period.
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
    // Equivalent to Stripe cancel_at_period_end. The subscription remains active
    // until the next_payment_date, then Paystack fires subscription.disable.
    case 'subscription.not_renew': {
      const subCode        = data.subscription_code as string | undefined;
      const nextPayment    = data.next_payment_date  as string | undefined;
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
            metadata: {
              paystackSubCode: subCode,
              nextPaymentDate: nextPayment,
            },
          },
        });
      });

      const endDateStr = nextPayment
        ? new Date(nextPayment).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
      const planName   = (sub as any).plan?.name ?? 'your plan';
      notifySubCancelled(sub.userId, planName, endDateStr, false)
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
            amountCents:       data.amount as number ?? 0,
            currency:          (data.currency as string ?? 'KES').toUpperCase(),
            status:            'failed',
            failureMessage:    data.gateway_response as string ?? null,
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

      const planName = (sub as any).plan?.name ?? 'your plan';
      notifyPaymentFailed(sub.userId, planName)
        .catch(err => console.error('[Webhook] payment_failed notification failed:', err));

      break;
    }

    // ── Expiring cards (trial ending equivalent notification) ─────────────────
    // Paystack fires this 5 days before a subscription's card expires.
    // We repurpose it to send the trial-ending notification when applicable.
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
        const planName = (sub as any).plan?.name ?? 'your plan';
        notifyTrialEnding(sub.userId, planName, daysLeft)
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
    // Paystack sends the signature in x-paystack-signature
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

    // Unique event identifier — Paystack does not provide a top-level event ID,
    // so we derive one from event type + reference (present on charge events)
    // or event type + subscription_code for subscription events.
    const reference      = event.data?.reference
                        ?? event.data?.subscription_code
                        ?? event.data?.id
                        ?? `${Date.now()}`;
    const externalId     = `${event.event}::${reference}`;

    // Atomic idempotency — identical pattern to original Stripe handler.
    // Unique constraint on externalId fires if another instance claimed this event.
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

    // Update the record with the final outcome (best-effort)
    if (processingError) {
      await prisma.webhookEvent.update({
        where: { externalId },
        data:  { responseStatus: 207, error: processingError },
      }).catch((e) => console.error('[Webhook] Failed to update event status:', e));
    }

    // Always return 200 — Paystack retries on non-200 responses.
    res.json({ received: true });
  },
);

export default router;
