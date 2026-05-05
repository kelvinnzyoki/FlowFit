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
      // FIX-W1: Removed `if (!data.plan) return` guard.
      // Paystack does not always populate data.plan on charge.success — the
      // subscription.create event arrives separately and sometimes data.plan
      // is absent or delayed. Bailing here left subscriptions permanently
      // INCOMPLETE. We now use the transaction reference to find our
      // INCOMPLETE row directly, which is reliable regardless of data.plan.

      const reference  = data.reference as string;
      const meta       = (data.metadata ?? {}) as Record<string, any>;
      const userId     = meta.userId   as string | undefined;
      const planId     = meta.planId   as string | undefined;
      const interval   = (meta.interval ?? 'MONTHLY') as BillingInterval;

      // FIX-CODES-2: Extract codes at the TOP LEVEL as `let` so the same
      // variables are visible throughout the entire case block — including
      // inside the $transaction callback. The previous code used `const`
      // declarations INSIDE the transaction callback which shadowed these
      // outer variables; those inner values were discarded after the callback
      // scope ended, leaving the outer variables undefined and the codes
      // never written to the DB.
      let subscriptionCode: string | undefined =
        data.subscription?.subscription_code ?? data.subscription_code ?? undefined;
      let emailToken: string | undefined =
        data.subscription?.email_token ?? data.email_token ?? undefined;

      if (!reference) {
        console.warn('[Webhook] charge.success: no reference in event data');
        return;
      }

      // Lookup Strategy 0 (NEW — most reliable): direct lookup by subscriptionId
      // embedded in Paystack metadata by createCheckoutSession. This is immune to
      // reference races and email mismatches. subscriptionId is now always present
      // in metadata because the INCOMPLETE row is created BEFORE the Paystack
      // transaction is initialised (see FIX-CODES-1 in subscription.service.ts).
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

      // If no INCOMPLETE row, check if this is a renewal (existing ACTIVE sub)
      const isRenewal = !existing;

      // FIX-W2: Calculate period end from interval when Paystack omits
      // next_payment_date. Previously this was set to `now` making the
      // subscription appear expired immediately.
      const now = new Date();
      let nextPaymentDate: Date | null = null;
      if (data.subscription?.next_payment_date) {
        nextPaymentDate = new Date(data.subscription.next_payment_date as string);
      } else {
        // Derive from interval so currentPeriodEnd is always in the future
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
        // Use the userId/planId from the INCOMPLETE row we found
      }

      
      await prisma.$transaction(async (tx) => {
        if (existing && (existing.status === 'INCOMPLETE' || existing.status === 'TRIALING')) {
          // FIX-CODES-2: Do NOT re-declare subscriptionCode/emailToken here.
          // They are already extracted at the top of the case block as `let`
          // variables. Re-declaring them as `const` inside this callback scope
          // was the shadow-variable bug: the inner consts were discarded when
          // the callback returned, so the outer variables always remained
          // undefined and null was written to the DB.
          // Instead, fall back to any value already in the DB if Paystack
          // omits them from this event (subscription.create will fill gaps).
          subscriptionCode = subscriptionCode ?? existing.paystackSubscriptionCode ?? undefined;
          emailToken       = emailToken       ?? existing.paystackEmailToken       ?? undefined;

          console.log(`[Webhook] charge.success - Saving codes for sub ${existing.id}`, {
            subscriptionCode, emailToken
          });

          const effectivePlanId = planId ?? existing.planId;

          await tx.subscription.update({
            where: { id: existing.id },
            data: {
              status:                   'ACTIVE',
              provider:                 'PAYSTACK',
              interval,
              planId:                   effectivePlanId,
              paystackSubscriptionCode: subscriptionCode,
              paystackEmailToken:       emailToken,
              paystackReference:        reference,
              currentPeriodStart:       now,
              currentPeriodEnd:         nextPaymentDate,
              activatedAt:              now,
              cancelAtPeriodEnd:        false,
            },
          });
          await tx.payment.create({
            data: {
              subscriptionId:    existing.id,
              paystackReference: reference,
              amountCents:       data.amount as number,
              currency:          ((data.currency as string) ?? 'KES').toUpperCase(),
              status:            'succeeded',
              paidAt:            now,
              provider:          'PAYSTACK',
            },
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
          // ── Renewal: find ACTIVE sub by subscription code ─────────────────────
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
            // Fallback: create from scratch
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
                paystackSubscriptionCode: subscriptionCode  ?? null,
                paystackEmailToken:       emailToken        ?? null,
                paystackReference:        reference,
                currentPeriodStart:       now,
                currentPeriodEnd:         nextPaymentDate,
                activatedAt:              now,
              },
            });
            await tx.payment.create({
              data: {
                subscriptionId:    created.id,
                paystackReference: reference,
                amountCents:       data.amount as number,
                currency:          ((data.currency as string) ?? 'KES').toUpperCase(),
                status:            'succeeded',
                paidAt:            now,
                provider:          'PAYSTACK',
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

          await tx.payment.create({
            data: {
              subscriptionId:    sub.id,
              paystackReference: reference,
              amountCents:       data.amount as number,
              currency:          ((data.currency as string) ?? 'KES').toUpperCase(),
              status:            'succeeded',
              paidAt:            now,
              provider:          'PAYSTACK',
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
      if (!isRenewal && existing) {
        const notifyUserId = userId ?? existing.userId;
        const notifyPlanId = planId ?? existing.planId;
        (async () => {
          try {
            const plan = await prisma.plan.findUnique({
              where:  { id: notifyPlanId },
              select: { name: true },
            });
            await notifySubActivated(notifyUserId, plan?.name ?? 'Premium', 'PAYSTACK');
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
    // subscription.create fires after charge.success and contains the definitive
    // subscription_code + email_token. We use it to ensure these are always stored.
    //
    // FIX: The payload does NOT include metadata (no userId). Paystack only forwards
    // metadata in charge.success. We must look up the subscription by:
    //   1. paystackReference (most reliable — stored at checkout creation)
    //   2. customer email → user lookup (fallback when reference not in payload)
    //   3. subscription_code already on a recent ACTIVE/INCOMPLETE row (last resort)
    case 'subscription.create': {
      const subCode    = data.subscription_code as string | undefined;
      const emailToken = data.email_token        as string | undefined;
      const custEmail  = data.customer?.email    as string | undefined;

      // Paystack's subscription.create payload does not carry the original
      // transaction metadata (userId, planId, subscriptionId).
      // However, the most_recent_invoice object contains the transaction reference
      // which WAS set in our DB. Use it as Strategy 0.
      const invoiceTxRef = data.most_recent_invoice?.transaction as string | undefined;

      if (!subCode) return;

      // Lookup strategy 0 (NEW — most reliable): match by paystackReference stored
      // on the INCOMPLETE row. The invoice transaction field is the reference we set
      // in createCheckoutSession (format: ff_<userId12>_<timestamp>).
      let dbSub: typeof (await prisma.subscription.findFirst({ where: { id: '' } })) = null;

      if (invoiceTxRef) {
        dbSub = await prisma.subscription.findFirst({
          where:   { paystackReference: invoiceTxRef },
          orderBy: { createdAt: 'desc' },
        });
      }

      // Lookup strategy 1: find a row already tagged with this subscription code
      // (charge.success may have stored the code before this event fired)
      if (!dbSub) {
        dbSub = await prisma.subscription.findFirst({
          where:   { paystackSubscriptionCode: subCode },
          orderBy: { createdAt: 'desc' },
        });
      }

      // Lookup strategy 2: match by customer email → user (most reliable first-time path)
      if (!dbSub && custEmail) {
        const user = await prisma.user.findUnique({
          where:  { email: custEmail },
          select: { id: true },
        });
        if (user) {
          dbSub = await prisma.subscription.findFirst({
            where:   { userId: user.id, status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING', 'PAST_DUE'] } },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      // Lookup strategy 3: most recently created INCOMPLETE row scoped to the
      // customer's email to avoid cross-user contamination.
      // FIX-CODES-3: The previous implementation matched ANY recent INCOMPLETE
      // PAYSTACK row with no user scoping — this could write the wrong user's
      // subscription codes onto a different user's row.
      if (!dbSub && custEmail) {
        const user = await prisma.user.findUnique({
          where:  { email: custEmail },
          select: { id: true },
        });
        if (user) {
          dbSub = await prisma.subscription.findFirst({
            where:   { userId: user.id, status: 'INCOMPLETE', provider: 'PAYSTACK' },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      if (!dbSub) {
        console.warn('[Webhook] subscription.create: no matching subscription found for code:', subCode, '| invoiceTxRef:', invoiceTxRef, '| custEmail:', custEmail);
        return;
      }

      // Always update — charge.success may have stored the code but not the emailToken,
      // or may have written null for both when /transaction/verify omitted them.
      // subscription.create is the ONLY reliable source of email_token.
      await prisma.subscription.update({
        where: { id: dbSub.id },
        data: {
          paystackSubscriptionCode: subCode || dbSub.paystackSubscriptionCode,
          paystackEmailToken:       emailToken || dbSub.paystackEmailToken,
        },
      });

      // Fire trial-started notification if applicable
      if (dbSub.trialEndsAt && dbSub.trialEndsAt > new Date()) {
        const plan = await prisma.plan.findUnique({
          where:  { id: dbSub.planId },
          select: { name: true, trialDays: true },
        });
        const planName = plan?.name ?? 'Premium';
        const msLeft   = dbSub.trialEndsAt.getTime() - Date.now();
        const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
        notifyTrialStarted(dbSub.userId, planName, daysLeft)
          .catch(err => console.error('[Webhook] trial_started notification failed:', err));
      }

      break;
    }

    // ── Subscription disabled (cancelled) ────────────────────────────────────
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
