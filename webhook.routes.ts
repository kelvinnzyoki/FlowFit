/**
 * FLOWFIT — Stripe Webhook Handler
 *
 * Security model:
 *   1. Raw body required — express.json() must NOT run before this route
 *   2. Signature verified against STRIPE_WEBHOOK_SECRET
 *   3. WebhookEvent table provides idempotency — duplicate events are no-ops
 *   4. All DB writes are wrapped in transactions
 *   5. Handler always returns 200 to Stripe even on business-logic errors
 *      (to prevent Stripe retries on logic errors vs infra errors)
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, SubscriptionStatus, BillingInterval } from '@prisma/client';
import { constructWebhookEvent } from '../services/stripe.service';
import Stripe from 'stripe';

const router = Router();
const prisma = new PrismaClient();

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

async function mapStripeStatus(stripeStatus: string): Promise<SubscriptionStatus> {
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

      const stripeSub = await (await import('./webhook.routes')).fetchStripeSub(stripeSubId);

      await prisma.$transaction(async (tx) => {
        // Find the pending INCOMPLETE record created during checkout
        const existing = await tx.subscription.findFirst({
          where: {
            userId,
            stripeCheckoutSessionId: session.id,
            status: 'INCOMPLETE',
          },
        });

        const newStatus = await mapStripeStatus(stripeSub.status);
        const data = {
          stripeSubscriptionId: stripeSubId,
          status: newStatus,
          interval: (interval ?? 'MONTHLY') as BillingInterval,
          currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
          currentPeriodEnd:   new Date(stripeSub.current_period_end   * 1000),
          trialEndsAt:        stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : undefined,
          activatedAt:        newStatus === 'ACTIVE' ? new Date() : undefined,
        };

        if (existing) {
          await tx.subscription.update({ where: { id: existing.id }, data });
          await tx.subscriptionLog.create({
            data: {
              subscriptionId: existing.id,
              event: newStatus === 'TRIALING' ? 'TRIAL_STARTED' : 'ACTIVATED',
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
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.subscription) return;

      const stripeSub = await fetchStripeSub(invoice.subscription as string);
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: invoice.subscription as string },
      });
      if (!sub) return;

      const prevStatus = sub.status;
      const newStatus  = await mapStripeStatus(stripeSub.status);

      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: newStatus,
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd:   new Date(stripeSub.current_period_end   * 1000),
            activatedAt:        prevStatus !== 'ACTIVE' ? new Date() : undefined,
          },
        });

        await tx.payment.create({
          data: {
            subscriptionId:       sub.id,
            stripeInvoiceId:      invoice.id,
            stripePaymentIntentId: typeof invoice.payment_intent === 'string' ? invoice.payment_intent : undefined,
            amountCents:          invoice.amount_paid,
            currency:             invoice.currency.toUpperCase(),
            status:               'succeeded',
          },
        });

        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          'PAYMENT_SUCCEEDED',
            previousStatus: prevStatus,
            newStatus,
            metadata: { stripeEventId: event.id, invoiceId: invoice.id, amountCents: invoice.amount_paid },
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
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });
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

    // ── Subscription updated (plan change, interval change, etc.) ─────────────
    case 'customer.subscription.updated': {
      const stripeSub = event.data.object as Stripe.Subscription;
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: stripeSub.id },
      });
      if (!sub) return;

      const prevStatus = sub.status;
      const newStatus  = await mapStripeStatus(stripeSub.status);

      // Detect trial conversion
      const prevSub = event.data.previous_attributes as any;
      const trialConverted = prevSub?.status === 'trialing' && stripeSub.status === 'active';

      // Detect scheduled downgrade applied (plan changed)
      let appliedPlanId: string | undefined;
      if (sub.scheduledPlanId) {
        // Check if the Stripe price now matches the scheduled plan's price
        const scheduledPlan = await prisma.plan.findUnique({ where: { id: sub.scheduledPlanId } });
        const currentPriceId = stripeSub.items.data[0]?.price.id;
        if (
          scheduledPlan &&
          (scheduledPlan.stripePriceIdMonthly === currentPriceId ||
           scheduledPlan.stripePriceIdYearly === currentPriceId)
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
            trialEndsAt:        stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : undefined,
            activatedAt:        trialConverted ? new Date() : undefined,
            planId:             appliedPlanId ?? sub.planId,
            scheduledPlanId:    appliedPlanId ? null : undefined,
            scheduledInterval:  appliedPlanId ? null : undefined,
          },
        });

        const logEvent = trialConverted ? 'TRIAL_CONVERTED'
          : appliedPlanId ? 'DOWNGRADE_APPLIED'
          : 'ACTIVATED';

        await tx.subscriptionLog.create({
          data: {
            subscriptionId: sub.id,
            event:          logEvent,
            previousStatus: prevStatus,
            newStatus,
            metadata: { stripeEventId: event.id, stripeStatus: stripeSub.status },
          },
        });
      });
      break;
    }

    // ── Subscription cancelled (hard delete or manual) ────────────────────────
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

    // ── Trial will end soon (send reminder emails here) ───────────────────────
    case 'customer.subscription.trial_will_end': {
      const stripeSub = event.data.object as Stripe.Subscription;
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: stripeSub.id },
        include: { user: true },
      });
      if (!sub) return;
      // TODO: trigger email notification service
      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: sub.id,
          event:          'TRIAL_STARTED', // reuse closest event; add TRIAL_ENDING if needed
          previousStatus: sub.status,
          newStatus:      sub.status,
          metadata: { stripeEventId: event.id, trialEnd: stripeSub.trial_end },
        },
      });
      break;
    }

    default:
      // Log unhandled events but don't error — future-proofing
      break;
  }
}

// ─── Export helper used by handler (avoids circular import) ──────────────────
export async function fetchStripeSub(id: string) {
  const { stripe } = await import('../services/stripe.service');
  return stripe.subscriptions.retrieve(id);
}

// ─── Route handler ────────────────────────────────────────────────────────────
// IMPORTANT: This route must be registered BEFORE express.json() middleware.
// Use express.raw({ type: 'application/json' }) on this route only.
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

    // ── Idempotency check ─────────────────────────────────────────────────────
    const alreadyProcessed = await prisma.webhookEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (alreadyProcessed) {
      // Silently acknowledge — Stripe may resend events
      res.json({ received: true, duplicate: true });
      return;
    }

    // ── Process ───────────────────────────────────────────────────────────────
    let processingError: string | null = null;
    try {
      await processEvent(event);
    } catch (err: any) {
      // Log but don't return non-2xx — Stripe would keep retrying
      console.error(`[Webhook] Error processing ${event.type}:`, err);
      processingError = err.message;
    }

    // ── Record in idempotency table ───────────────────────────────────────────
    await prisma.webhookEvent.create({
      data: {
        stripeEventId:  event.id,
        eventType:      event.type,
        responseStatus: processingError ? 207 : 200,
        error:          processingError,
      },
    }).catch((e) => console.error('[Webhook] Failed to record event:', e));

    res.json({ received: true });
  },
);

export default router;