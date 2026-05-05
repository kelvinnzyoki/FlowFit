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
 *
 * FIXES IN THIS VERSION:
 *   [WH-1] charge.success renewal path was updating paystackEmailToken but silently
 *           dropping paystackSubscriptionCode. Added it to the renewal update.
 *   [WH-2] subscription.create Strategy 3 (last-resort) was filtered to
 *           status:'INCOMPLETE' only. By the time subscription.create fires,
 *           charge.success has already promoted the row to ACTIVE, so Strategy 3
 *           never matched. Expanded to include ACTIVE and TRIALING.
 *   [WH-3] subscription.create had no lookup by paystackCustomerCode even though
 *           that field is stored on both the Subscription row and the User row at
 *           checkout time, and data.customer.customer_code is present in the
 *           subscription.create payload. Added as the new Strategy 2 (most direct
 *           cross-reference). Former Strategy 2 (email) is now Strategy 3.
 *           Added Strategy 4: customer_code on User row → userId → subscription
 *           (covers the edge case where paystackCustomerCode is on the user but
 *           not yet propagated to the subscription row).
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

      const reference        = data.reference                          as string;
      const subscriptionCode = data.subscription?.subscription_code   as string | undefined;
      const emailToken       = data.subscription?.email_token         as string | undefined;
      const meta             = (data.metadata ?? {}) as Record<string, any>;
      const userId           = meta.userId   as string | undefined;
      const planId           = meta.planId   as string | undefined;
      const interval         = (meta.interval ?? 'MONTHLY') as BillingInterval;

      if (!reference) {
        console.warn('[Webhook] charge.success: no reference in event data');
        return;
      }

      // Primary lookup: find our INCOMPLETE row by reference (set in createCheckoutSession)
      // Fallback: find by userId + planId from metadata (handles edge cases where
      // paystackReference wasn't stored, e.g. race between webhook and DB write)
      let existing = await prisma.subscription.findFirst({
        where:   { paystackReference: reference, status: 'INCOMPLETE' },
        orderBy: { createdAt: 'desc' },
      });

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
          // ── First payment: activate the INCOMPLETE / free-trial row ───────────
          const effectivePlanId = planId ?? existing.planId;
          await tx.subscription.update({
            where: { id: existing.id },
            data: {
              status:                   'ACTIVE',
              provider:                 'PAYSTACK',
              interval,
              planId:                   effectivePlanId,
              paystackSubscriptionCode: subscriptionCode  ?? existing.paystackSubscriptionCode ?? null,
              paystackEmailToken:       emailToken        ?? existing.paystackEmailToken       ?? null,
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
              // [WH-1] FIX: paystackSubscriptionCode was absent from the renewal
              // update. On renewal, Paystack sends subscription_code in
              // data.subscription — we must persist it so the row stays in sync
              // (needed for enable/disable and billing portal calls).
              paystackSubscriptionCode: subscriptionCode ?? sub.paystackSubscriptionCode,
              paystackEmailToken:       emailToken       ?? sub.paystackEmailToken,
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
    // NOTE: This payload does NOT contain our transaction reference or metadata.
    // Paystack only forwards custom metadata in charge.success. All lookups here
    // must use fields present in the subscription.create payload:
    //   data.subscription_code  — the new subscription code (always present)
    //   data.email_token        — the management token (always present)
    //   data.customer.email     — user's email (present)
    //   data.customer.customer_code — Paystack customer code (present)
    //
    // Lookup strategies (ordered by reliability):
    //   1. paystackSubscriptionCode match — succeeds if charge.success stored it
    //   2. paystackCustomerCode on Subscription row — direct FK, most reliable
    //   3. customer email → user lookup (reliable fallback)
    //   4. paystackCustomerCode on User row → userId → subscription (edge-case cover)
    //   5. Most recent INCOMPLETE/ACTIVE/TRIALING Paystack row — last resort
    //
    // [WH-2] FIX: Former Strategy 3 (last-resort) only searched status:'INCOMPLETE'.
    //   By the time this event fires, charge.success has already set the row to
    //   ACTIVE. Expanded to include ACTIVE and TRIALING.
    // [WH-3] FIX: Added Strategies 2 and 4 which use paystackCustomerCode — the
    //   field stored on both the Subscription row and the User row at checkout.
    //   data.customer.customer_code is always present in this payload and is a
    //   more direct cross-reference than email.
    case 'subscription.create': {
      const subCode    = data.subscription_code          as string | undefined;
      const emailToken = data.email_token                as string | undefined;
      const custEmail  = data.customer?.email            as string | undefined;
      const custCode   = data.customer?.customer_code    as string | undefined;

      if (!subCode) return;

      // ── Strategy 1: row already tagged with this subscription code ────────
      // charge.success may have stored the code before this event fired.
      let dbSub = await prisma.subscription.findFirst({
        where:   { paystackSubscriptionCode: subCode },
        orderBy: { createdAt: 'desc' },
      });

      // ── Strategy 2 [NEW]: match by paystackCustomerCode on Subscription row ─
      // createCheckoutSession stores paystackCustomerCode on the subscription row
      // when the INCOMPLETE row is created. data.customer.customer_code is the
      // same value — this is the most direct single-query cross-reference available
      // in the subscription.create payload.
      if (!dbSub && custCode) {
        dbSub = await prisma.subscription.findFirst({
          where: {
            paystackCustomerCode: custCode,
            status:               { in: ['ACTIVE', 'INCOMPLETE', 'TRIALING', 'PAST_DUE'] },
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      // ── Strategy 3: match by customer email → user (was former Strategy 2) ─
      if (!dbSub && custEmail) {
        const user = await prisma.user.findUnique({
          where:  { email: custEmail },
          select: { id: true },
        });
        if (user) {
          dbSub = await prisma.subscription.findFirst({
            where:   {
              userId: user.id,
              status: { in: ['ACTIVE', 'INCOMPLETE', 'TRIALING', 'PAST_DUE'] },
            },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      // ── Strategy 4 [NEW]: paystackCustomerCode on User row → subscription ──
      // Covers the edge case where paystackCustomerCode was stored on the user
      // but hadn't propagated to the subscription row yet (e.g. a race between
      // the DB write and the webhook arriving).
      if (!dbSub && custCode) {
        const userWithCode = await prisma.user.findFirst({
          where:  { paystackCustomerCode: custCode },
          select: { id: true },
        });
        if (userWithCode) {
          dbSub = await prisma.subscription.findFirst({
            where: {
              userId: userWithCode.id,
              status: { in: ['ACTIVE', 'INCOMPLETE', 'TRIALING', 'PAST_DUE'] },
            },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      // ── Strategy 5: most recently created PAYSTACK row (last resort) ──────
      // [WH-2] FIX: was status:'INCOMPLETE' only, which never matched after
      // charge.success promoted the row to ACTIVE. Expanded to ACTIVE/TRIALING.
      if (!dbSub) {
        dbSub = await prisma.subscription.findFirst({
          where:   {
            status:   { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING'] },
            provider: 'PAYSTACK',
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      if (!dbSub) {
        console.warn('[Webhook] subscription.create: no matching subscription found for code:', subCode);
        return;
      }

      // Always update — charge.success may have stored the code but not the emailToken,
      // or may have written null for both when /transaction/verify omitted them.
      // subscription.create is the ONLY reliable source of email_token.
      await prisma.subscription.update({
        where: { id: dbSub.id },
        data: {
          paystackSubscriptionCode: subCode,
          paystackEmailToken:       emailToken ?? dbSub.paystackEmailToken,
        },
      });

      console.log(
        `[Webhook] subscription.create: stored code=${subCode} emailToken=${emailToken ? 'yes' : 'no'} ` +
        `on sub=${dbSub.id} via strategy ${
          dbSub.paystackSubscriptionCode === subCode ? '1'
          : dbSub.paystackCustomerCode === custCode  ? '2'
          : custEmail                                ? '3'
          : custCode                                 ? '4'
          : '5'
        }`,
      );

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
