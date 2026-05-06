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
 *   FIX-W5  charge.success: after activation, if subscription_code/email_token
 *           were absent from the charge.success payload (normal — Paystack does
 *           NOT include them on the first payment charge.success), a
 *           fire-and-forget background task immediately queries
 *           GET /subscription?customer=CUS_xxx to pre-fetch the codes.
 *           This runs alongside the subscription.create webhook as a safety
 *           net. If subscription.create arrives first, its DB update is
 *           idempotent (uses || to preserve existing value). On serverless
 *           runtimes that kill background tasks at response time this is a
 *           no-op; subscription.create remains the authoritative source.
 *
 * All other logic, idempotency, and DB patterns are unchanged.
 */

import { Router, Request, Response }   from 'express';
import { SubscriptionStatus, BillingInterval } from '@prisma/client';
import prisma                           from '../config/db.js';
import {
  verifyPaystackWebhook,
  PaystackWebhookEvent,
  findPaystackSubscriptionByCustomer,   // FIX-W5: needed for background fetch
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

      // ── FIX-W5: Background code fetch (safety net) ───────────────────────
      // charge.success for a first payment NEVER carries subscription_code /
      // email_token — Paystack creates the Subscription object asynchronously
      // after the charge. subscription.create (FIX-W3) is the authoritative
      // source and will store them. This background task is a belt-and-
      // suspenders fallback: it queries GET /subscription?customer=CUS_xxx
      // ~3 s after activation to store the codes early, so features that
      // need them (billing portal, cancel) work even if subscription.create
      // is delayed.
      //
      // On serverless runtimes (Vercel/Lambda) the process may be frozen
      // immediately after res.json(), so this is best-effort only.
      // On traditional Node.js servers (Railway, VPS) it runs reliably.
      if (!subscriptionCode && !isRenewal && existing?.paystackCustomerCode) {
        const subIdToFetch   = existing.id;
        const custCodeToFetch = existing.paystackCustomerCode;
        (async () => {
          try {
            // Give Paystack ~3 s to create the Subscription object
            await new Promise<void>(r => setTimeout(r, 3_000));
            const found = await findPaystackSubscriptionByCustomer(custCodeToFetch);
            if (found?.subscription_code) {
              await prisma.subscription.update({
                where: { id: subIdToFetch },
                data: {
                  paystackSubscriptionCode: found.subscription_code,
                  ...(found.email_token ? { paystackEmailToken: found.email_token } : {}),
                  ...(found.next_payment_date
                    ? { currentPeriodEnd: new Date(found.next_payment_date) }
                    : {}),
                },
              });
              console.log(
                `[Webhook] charge.success bg-fetch: stored sub code ${found.subscription_code}` +
                ` for sub ${subIdToFetch}`,
              );
            } else {
              console.log(
                `[Webhook] charge.success bg-fetch: Paystack sub not yet available for ` +
                `customer ${custCodeToFetch} — subscription.create will handle it`,
              );
            }
          } catch (bgErr) {
            // Non-fatal: subscription.create is the authoritative handler
            console.warn('[Webhook] charge.success bg-fetch failed (non-fatal):', bgErr);
          }
        })();
      }

      break;
    }

    // ── Subscription created ──────────────────────────────────────────────────
    // Fires when Paystack creates the Subscription object (~3-5 min after first
    // charge.success). This event is the ONLY reliable source of
    // subscription_code and email_token — storing them here is the primary fix.
    //
    // FIX-W3: Rewrote all lookup strategies. See module-level comment.
    case 'subscription.create': {
      const subCode      = data.subscription_code as string | undefined;
      const emailToken   = data.email_token        as string | undefined;
      const custEmail    = data.customer?.email         as string | undefined;
      // FIX-W3 Root cause B: customer_code was never used as a lookup key even
      // though we store it in the INCOMPLETE row at checkout creation and
      // Paystack always includes it here. It is now Strategy 0.
      const customerCode = data.customer?.customer_code as string | undefined;

      console.log('[Webhook] subscription.create received', {
        subCode,
        hasEmailToken: !!emailToken,
        custEmail,
        customerCode,
      });

      if (!subCode) {
        console.warn('[Webhook] subscription.create: no subscription_code in payload — skipping');
        return;
      }

      let dbSub: Awaited<ReturnType<typeof prisma.subscription.findFirst>> = null;

      // ── Strategy 0 (NEW — most reliable): lookup by paystackCustomerCode ──
      // We write paystackCustomerCode onto the INCOMPLETE row inside
      // createCheckoutSession before calling initializeTransaction. Paystack
      // always returns customer.customer_code in subscription.create.
      // This link is: immutable, unique, case-exact, and race-free.
      // Previous Strategy 0 used data.most_recent_invoice?.transaction which
      // is Paystack's numeric internal transaction ID — NOT our reference string.
      // That query silently matched nothing every time. (FIX-W3 Root cause A)
      if (customerCode) {
        dbSub = await prisma.subscription.findFirst({
          where: {
            paystackCustomerCode: customerCode,
            status: { in: ['INCOMPLETE', 'ACTIVE', 'TRIALING', 'PAST_DUE'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (dbSub) {
          console.log(`[Webhook] subscription.create: found sub ${dbSub.id} via paystackCustomerCode`);
        }
      }

      // ── Strategy 1: find by subscription code already stored ──────────────
      // charge.success sometimes includes subscription_code for renewals;
      // if so, it would have stored it during the charge.success handler.
      if (!dbSub) {
        dbSub = await prisma.subscription.findFirst({
          where:   { paystackSubscriptionCode: subCode },
          orderBy: { createdAt: 'desc' },
        });
        if (dbSub) {
          console.log(`[Webhook] subscription.create: found sub ${dbSub.id} via subscriptionCode`);
        }
      }

      // ── Strategy 2: customer email → user → most recent matching sub ──────
      // Fallback when customerCode is absent or not yet stored. Searches all
      // active-ish statuses so it matches regardless of whether charge.success
      // ran first (ACTIVE) or hasn't run yet (INCOMPLETE).
      // FIX-W3 Root cause C (preserved fix): removed the INCOMPLETE-only
      // Strategy 3 — by the time subscription.create fires, status is ACTIVE.
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
            },
            orderBy: { createdAt: 'desc' },
          });
          if (dbSub) {
            console.log(`[Webhook] subscription.create: found sub ${dbSub.id} via custEmail`);
          }
        }
      }

      if (!dbSub) {
        console.error(
          '[Webhook] subscription.create: NO matching subscription found.',
          { subCode, customerCode, custEmail },
          '— subscription_code and email_token will NOT be stored.',
        );
        return;
      }

      // ── FIX-W4: Activate if still INCOMPLETE ─────────────────────────────
      // subscription.create can arrive before charge.success (Paystack event
      // order is not guaranteed). If the row is still INCOMPLETE we activate
      // it here so the user does not have to wait for charge.success.
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
        console.log(
          `[Webhook] subscription.create: sub ${dbSub.id} is still INCOMPLETE — ` +
          'activating now (subscription.create arrived before charge.success)',
        );
      }

      // ── Always update codes ───────────────────────────────────────────────
      // subscription.create is the ONLY reliable source of email_token.
      // Use || not ?? so an empty string is also replaced by the live value.
      await prisma.subscription.update({
        where: { id: dbSub.id },
        data: {
          paystackSubscriptionCode: subCode      || dbSub.paystackSubscriptionCode,
          paystackEmailToken:       emailToken   || dbSub.paystackEmailToken,
          // Backfill customerCode if somehow missing
          ...(customerCode ? { paystackCustomerCode: customerCode } : {}),
          // Activate if still INCOMPLETE (FIX-W4)
          ...activationPatch,
        },
      });

      console.log(
        `[Webhook] subscription.create: ✅ stored codes for sub ${dbSub.id}`,
        { subCode, hasEmailToken: !!emailToken },
      );

      // ── Log the code-storage event ────────────────────────────────────────
      await prisma.subscriptionLog.create({
        data: {
          subscriptionId: dbSub.id,
          event:          'WEBHOOK_RECEIVED',
          previousStatus: dbSub.status,
          newStatus:      (activationPatch.status as any) ?? dbSub.status,
          metadata: {
            webhookEvent:           'subscription.create',
            paystackSubscriptionCode: subCode,
            hasEmailToken:          !!emailToken,
          },
        },
      }).catch(err => console.warn('[Webhook] subscription.create: log write failed (non-fatal):', err));

      // ── Trial-started notification ────────────────────────────────────────
      if (dbSub.trialEndsAt && dbSub.trialEndsAt > new Date()) {
        const plan = await prisma.plan.findUnique({
          where:  { id: dbSub.planId },
          select: { name: true, trialDays: true },
        });
        const msLeft   = dbSub.trialEndsAt.getTime() - Date.now();
        const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
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
