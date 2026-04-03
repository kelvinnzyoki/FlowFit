/**
 * FLOWFIT — Stripe Webhook Handler
 *
 * FIXES APPLIED:
 *   FIX-C5  customer.subscription.updated never did a DB lookup for `sub`.
 *           Every reference to sub.id, sub.planId, prevStatus threw
 *           ReferenceError. Added findFirst and early return if not found.
 *   FIX-C6  `const newStatus` was declared, then immediately reassigned in an
 *           if-block — a TypeError on const. Changed to `let` and removed
 *           the early partial update so a single transaction handles everything.
 *   FIX-C8  invoice.payment_succeeded case declared `const newStatus = 'ACTIVE'`
 *           at the case label (outside the block), then re-declared `const newStatus`
 *           inside the block — duplicate declaration error. Removed the first
 *           stray declaration and wrapped the case body in a proper { } block.
 *   FIX-H4  webhook_routes.ts instantiated its own `new PrismaClient()` creating
 *           a second connection pool. Changed to use the shared singleton from
 *           config/db.js (same as all other route files).
 */

import { Router, Request, Response } from 'express';
import { SubscriptionStatus, BillingInterval } from '@prisma/client';
import prisma from '../config/db.js';       // FIX-H4: shared singleton
import { constructWebhookEvent } from '../services/stripe.service.js';
import Stripe from 'stripe';

const router = Router();

// ─── Status mapping ───────────────────────────────────────────────────────────
const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  trialing:           'TRIALING',
  active:             'ACTIVE',
  past_due:           'PAST_DUE',
  canceled:           'CANCELLED',
  unpaid:             'PAST_DUE',
  incomplete:         'INCOMPLETE',
  incomplete_expired: 'INCOMPLETE_EXPIRED',
  paused:             'PAUSED',
};

function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  return STRIPE_STATUS_MAP[stripeStatus] ?? 'EXPIRED';
}

// ─── Core webhook processor ───────────────────────────────────────────────────
async function processEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {

    // ── Checkout completed ────────────────────────────────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') return;

      const stripeSubId = session.subscription as string;
      const { userId, planId, interval } = session.metadata ?? {};
      if (!userId || !planId) return;

      const stripeSub = await fetchStripeSub(stripeSubId);

      await prisma.$transaction(async (tx) => {
        const existing = await tx.subscription.findFirst({
          where: {
            userId,
            stripeCheckoutSessionId: session.id,
            status: 'INCOMPLETE',
          },
        });

        const newStatus = mapStripeStatus(stripeSub.status);
        const data = {
          stripeSubscriptionId: stripeSubId,
          status:               newStatus,
          interval:             (interval ?? 'MONTHLY') as BillingInterval,
          currentPeriodStart:   new Date(stripeSub.current_period_start * 1000),
          currentPeriodEnd:     new Date(stripeSub.current_period_end   * 1000),
          trialEndsAt:          stripeSub.trial_end
                                  ? new Date(stripeSub.trial_end * 1000)
                                  : undefined,
          activatedAt: newStatus === 'ACTIVE' ? new Date() : undefined,
        };

        if (existing) {
          await tx.subscription.update({ where: { id: existing.id }, data });
          await tx.subscriptionLog.create({
            data: {
              subscriptionId: existing.id,
              event:          newStatus === 'TRIALING' ? 'TRIAL_STARTED' : 'ACTIVATED',
              previousStatus: 'INCOMPLETE',
              newStatus,
              metadata: { stripeEventId: event.id, sessionId: session.id },
            },
          });
        }
      });
      break;
    }

    // ── Invoice paid — subscription renewed ──────────────────────────────────
    // FIX-C8: Removed the stray `const newStatus = 'ACTIVE'` that leaked out of
    //         this case block, then was re-declared inside the block.
    //         The entire case is now a proper { } block with one `const newStatus`.
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.subscription) return;

      const stripeSub = await fetchStripeSub(invoice.subscription as string);
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: invoice.subscription as string },
      });
      if (!sub) return;

      const prevStatus = sub.status;
      const newStatus  = mapStripeStatus(stripeSub.status);

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status:             newStatus,
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd:   new Date(stripeSub.current_period_end   * 1000),
            activatedAt:        prevStatus !== 'ACTIVE' ? new Date() : undefined,
          },
        });

        await tx.payment.create({
          data: {
            subscriptionId:        sub.id,
            stripeInvoiceId:       invoice.id,
            stripePaymentIntentId: typeof invoice.payment_intent === 'string'
                                     ? invoice.payment_intent
                                     : undefined,
            amountCents: invoice.amount_paid,
            currency:    invoice.currency.toUpperCase(),
            status:      'succeeded',
          },
        });

        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'PAYMENT_SUCCEEDED',
            previousStatus: prevStatus,
            newStatus,
            metadata: {
              stripeEventId: event.id,
              invoiceId:     invoice.id,
              amountCents:   invoice.amount_paid,
            },
          },
        });
      });
      break;
    }

    // ── Invoice payment failed ────────────────────────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.subscription) return;

      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: invoice.subscription as string },
      });
      if (!sub) return;

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data:  { status: 'PAST_DUE' },
        });

        await tx.payment.create({
          data: {
            subscriptionId:  sub.id,
            stripeInvoiceId: invoice.id,
            amountCents:     invoice.amount_due,
            currency:        invoice.currency.toUpperCase(),
            status:          'failed',
            failureMessage:  (invoice as any).last_finalization_error?.message ?? null,
          },
        });

        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'PAYMENT_FAILED',
            previousStatus: sub.status,
            newStatus:      'PAST_DUE',
            metadata: { stripeEventId: event.id, invoiceId: invoice.id },
          },
        });
      });
      break;
    }

    // ── Subscription updated ──────────────────────────────────────────────────
    // FIX-C5: `sub` was never declared — every reference threw ReferenceError.
    //         Added DB lookup and early return.
    // FIX-C6: `const newStatus` was reassigned — TypeError on const.
    //         Changed to `let`. Removed the early partial update; everything
    //         now happens in the single transaction at the bottom.
    case 'customer.subscription.updated': {
      const stripeSub = event.data.object as Stripe.Subscription;

      // FIX-C5: look up our local subscription record
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: stripeSub.id },
      });
      if (!sub) return;  // not a subscription we track

      const prevStatus = sub.status;

      // FIX-C6: `let` so it can be overridden if needed; keep mapStripeStatus as default
      let newStatus = mapStripeStatus(stripeSub.status);

      // Detect trial → active conversion
      const prevAttrs      = event.data.previous_attributes as any;
      const trialConverted = prevAttrs?.status === 'trialing' && stripeSub.status === 'active';

      // Detect scheduled downgrade applied (Stripe price now matches scheduled plan)
      let appliedPlanId: string | undefined;
      if (sub.scheduledPlanId) {
        const scheduledPlan  = await prisma.plan.findUnique({ where: { id: sub.scheduledPlanId } });
        const currentPriceId = stripeSub.items.data[0]?.price.id;
        if (
          scheduledPlan &&
          (scheduledPlan.stripePriceIdMonthly === currentPriceId ||
           scheduledPlan.stripePriceIdYearly  === currentPriceId)
        ) {
          appliedPlanId = sub.scheduledPlanId;
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status:             newStatus,
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd:   new Date(stripeSub.current_period_end   * 1000),
            cancelAtPeriodEnd:  stripeSub.cancel_at_period_end,
            trialEndsAt:        stripeSub.trial_end
                                  ? new Date(stripeSub.trial_end * 1000)
                                  : undefined,
            activatedAt:       trialConverted ? new Date() : undefined,
            planId:            appliedPlanId ?? sub.planId,
            scheduledPlanId:   appliedPlanId ? null : undefined,
            scheduledInterval: appliedPlanId ? null : undefined,
          },
        });

        const logEventType = trialConverted  ? 'TRIAL_CONVERTED'
                           : appliedPlanId   ? 'DOWNGRADE_APPLIED'
                           : 'ACTIVATED';

        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          logEventType,
            previousStatus: prevStatus,
            newStatus,
            metadata: { stripeEventId: event.id, stripeStatus: stripeSub.status },
          },
        });
      });
      break;
    }

    // ── Subscription cancelled ────────────────────────────────────────────────
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object as Stripe.Subscription;
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: stripeSub.id },
      });
      if (!sub) return;

      const prevStatus = sub.status;
      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status:      'CANCELLED',
            cancelledAt: new Date(),
            expiredAt:   new Date(),
          },
        });
        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'CANCELLED',
            previousStatus: prevStatus,
            newStatus:      'CANCELLED',
            metadata: { stripeEventId: event.id },
          },
        });
      });
      break;
    }

    // ── Trial ending soon ─────────────────────────────────────────────────────
    case 'customer.subscription.trial_will_end': {
      const stripeSub = event.data.object as Stripe.Subscription;
      const sub = await prisma.subscription.findFirst({
        where:   { stripeSubscriptionId: stripeSub.id },
        include: { user: true },
      });
      if (!sub) return;
      // TODO: trigger email notification service
      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event:          'RENEWAL_REMINDER_SENT',
          previousStatus: sub.status,
          newStatus:      sub.status,
          metadata: { stripeEventId: event.id, trialEnd: stripeSub.trial_end },
        },
      });
      break;
    }

    default:
      break;
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────
export async function fetchStripeSub(id: string) {
  const { stripe } = await import('../services/stripe.service.js');
  return stripe.subscriptions.retrieve(id);
}

// ─── Route handler ────────────────────────────────────────────────────────────
router.post(
  '/',
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(req.body as Buffer, sig);
    } catch (err: any) {
      console.error('[Webhook] Signature verification failed:', err.message);
      res.status(400).json({ error: `Webhook signature error: ${err.message}` });
      return;
    }

    const eventAge = Date.now() / 1000 - event.created;
  if (eventAge > 300) { // 5 minutes
    console.warn(`[Webhook] Rejected old event: ${event.id} (age: ${eventAge}s)`);
    return res.status(400).json({ error: 'Event too old' });
  }

    // Idempotency check
    const alreadyProcessed = await prisma.webhookEvent.findUnique({
      where: { externalId: event.id },
    });
    if (alreadyProcessed) {
      res.json({ received: true, duplicate: true });
      return;
    }

    let processingError: string | null = null;
    try {
      await processEvent(event);
    } catch (err: any) {
      console.error(`[Webhook] Error processing ${event.type}:`, err);
      processingError = err.message;
    }

    await prisma.webhookEvent.create({
      data: {
        externalId:     event.id,
        provider:       'stripe',
        eventType:      event.type,
        responseStatus: processingError ? 207 : 200,
        error:          processingError,
      },
    }).catch((e) => console.error('[Webhook] Failed to record event:', e));

    res.json({ received: true });
  },
);

export default router;
