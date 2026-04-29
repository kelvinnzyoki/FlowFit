/**
 * FLOWFIT — Notification Service  (V2)
 *
 * V2 additions:
 *   - Resend email client wired up (RESEND_API_KEY env var)
 *   - Every factory now fires both an in-app notification AND a transactional email
 *   - getUserEmailInfo() fetches name + email from User + Profile in one query
 *   - sendEmail() is always fire-and-forget with silent catch — never throws
 *   - HTML email templates branded to FlowFit (gold + dark, responsive)
 *   - FROM_EMAIL env var controls the sender address
 *
 * Called by:
 *   - auth_routes.ts              → welcome on first login
 *   - paystack.webhook.routes.ts  → plan activated / renewed / failed / cancelled / trial
 *   - progress_routes.ts          → milestone unlocked
 *   - cron jobs                   → subscription reminders, expiry
 *
 * FIX [NS-1]: notifySubActivated — provider parameter typed as 'STRIPE' | 'MPESA'.
 *   'PAYSTACK' was not in the union so the TS compiler rejected every call from
 *   paystack.webhook.routes.ts with TS2345.
 *   Fixed: parameter now typed as PaymentProvider (imported from @prisma/client),
 *   which is the single source of truth: PAYSTACK | MPESA | MANUAL.
 *   providerLabel map updated accordingly — 'Stripe' label replaced with 'Paystack'.
 */

import prisma              from '../config/db.js';
import { PaymentProvider } from '@prisma/client';   // [NS-1] replaces the hand-rolled union
import { Resend }          from 'resend';

// ─── Email client ────────────────────────────────────────────────────────────
//
// Instantiated lazily so the service still works in environments where
// RESEND_API_KEY is not yet set (email is skipped, in-app still fires).

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const FROM_EMAIL     = process.env.RESEND_FROM_EMAIL ?? 'FlowFit <noreply@flowfit.app>';

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(RESEND_API_KEY);
  return _resend;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'welcome'
  | 'sub_activated'
  | 'sub_trial'
  | 'sub_expired'
  | 'sub_cancelled'
  | 'sub_renewed'
  | 'sub_failed'
  | 'milestone'
  | 'achievement'
  | 'system';

export interface CreateNotificationInput {
  userId:  string;
  type:    NotificationType;
  title:   string;
  body:    string;
  icon?:   string;
  link?:   string;
}

// ─── Default icons per type ──────────────────────────────────────────────────
const TYPE_ICON: Record<NotificationType, string> = {
  welcome:       '👋',
  sub_activated: '🎉',
  sub_trial:     '⏳',
  sub_expired:   '⌛',
  sub_cancelled: '🚫',
  sub_renewed:   '✅',
  sub_failed:    '⚠️',
  milestone:     '🔥',
  achievement:   '🏆',
  system:        '📣',
};

// ─── User info helper ────────────────────────────────────────────────────────

interface UserEmailInfo {
  email: string;
  name:  string;
}

async function getUserEmailInfo(userId: string): Promise<UserEmailInfo | null> {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        email:   true,
        profile: { select: { firstName: true, lastName: true } },
      },
    });
    if (!user?.email) return null;

    const name =
      [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ')
      || user.email.split('@')[0];

    return { email: user.email, name };
  } catch {
    return null;
  }
}

// ─── Email sender (always fire-and-forget) ───────────────────────────────────
//
// Callers use:  sendEmail(...).catch(...)  — or simply don't await at all
// if they want true fire-and-forget.  Either way this never throws upstream.

async function sendEmail(
  userId:  string,
  subject: string,
  html:    string,
): Promise<void> {
  const resend = getResend();
  if (!resend) return;   // RESEND_API_KEY not set — silent skip

  const info = await getUserEmailInfo(userId);
  if (!info) return;     // no email address on record

  await resend.emails.send({
    from:    FROM_EMAIL,
    to:      [info.email],
    subject,
    html,
  });
}

// ─── Shared email layout ─────────────────────────────────────────────────────
//
// Single-column responsive template.  Body content is injected at {CONTENT}.

function emailLayout(previewText: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${previewText}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#0d0c14;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <!-- Preview text (hidden) -->
  <span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${previewText}&nbsp;&#8204;&nbsp;&#8204;&nbsp;</span>

  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0d0c14;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Card -->
        <table role="presentation" cellpadding="0" cellspacing="0" width="560"
               style="max-width:560px;width:100%;background:#141220;border-radius:16px;
                      border:1px solid rgba(201,168,76,0.18);overflow:hidden;">

          <!-- Gold top bar -->
          <tr>
            <td style="height:3px;background:linear-gradient(90deg,#8E6E28,#C9A84C,#E8C96A,#C9A84C,#8E6E28);"></td>
          </tr>

          <!-- Logo row -->
          <tr>
            <td align="center" style="padding:28px 40px 0;">
              <span style="font-size:22px;font-weight:700;letter-spacing:0.08em;
                           font-family:Georgia,serif;color:#C9A84C;">FLOW</span><span
                    style="font-size:22px;font-weight:700;letter-spacing:0.08em;
                           font-family:Georgia,serif;color:#F0EBE0;">FIT</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 40px 36px;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:11px;color:#5a5670;text-align:center;line-height:1.6;">
                You are receiving this email because you have a FlowFit account.<br>
                © ${new Date().getFullYear()} FlowFit. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Reusable template helpers ───────────────────────────────────────────────

function h1(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#F0EBE0;line-height:1.3;">${text}</h1>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;color:#a09ab0;line-height:1.7;">${text}</p>`;
}

function ctaButton(label: string, href: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
    <tr>
      <td style="background:linear-gradient(135deg,#C9A84C,#E8C96A);border-radius:8px;">
        <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:14px;
           font-weight:600;letter-spacing:0.05em;color:#0a0a0a;text-decoration:none;">
          ${label}
        </a>
      </td>
    </tr>
  </table>`;
}

function infoBox(rows: Array<[string, string]>): string {
  const rowsHtml = rows.map(([k, v]) => `
    <tr>
      <td style="padding:8px 16px;font-size:13px;color:#7a7490;border-bottom:1px solid rgba(255,255,255,0.05);">${k}</td>
      <td style="padding:8px 16px;font-size:13px;color:#F0EBE0;text-align:right;border-bottom:1px solid rgba(255,255,255,0.05);">${v}</td>
    </tr>`).join('');
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
         style="margin:20px 0;background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.14);
                border-radius:10px;overflow:hidden;">
    ${rowsHtml}
  </table>`;
}

// ─── App base URL (for CTA links in emails) ──────────────────────────────────
const APP_URL = (process.env.APP_URL ?? 'https://app.flowfit.app').replace(/\/$/, '');

// ─── Create (in-app record) ──────────────────────────────────────────────────

export async function createNotification(input: CreateNotificationInput): Promise<void> {
  await prisma.notification.create({
    data: {
      userId:  input.userId,
      type:    input.type,
      title:   input.title,
      body:    input.body,
      icon:    input.icon ?? TYPE_ICON[input.type],
      link:    input.link ?? null,
    },
  });
}

// ─── Convenience factories ───────────────────────────────────────────────────
//
// Each factory:
//   1. Writes the in-app notification (always, never throws)
//   2. Fires a Resend email (fire-and-forget, errors are logged only)

export async function notifyWelcome(userId: string, name: string): Promise<void> {
  await createNotification({
    userId,
    type:  'welcome',
    title: `Welcome to FlowFit, ${name}! 🎉`,
    body:  'Your fitness journey starts today. Explore workouts, track your progress, and crush your goals.',
    link:  'workouts.html',
  });

  sendEmail(
    userId,
    `Welcome to FlowFit, ${name}!`,
    emailLayout(`Welcome to FlowFit, ${name}!`, `
      ${h1(`Welcome, ${name}! 🎉`)}
      ${p('Your FlowFit account is ready. Everything you need to hit your fitness goals is waiting for you.')}
      ${ctaButton('Start Your First Workout', `${APP_URL}/workouts.html`)}
      ${p('Questions? Just reply to this email — we\'re here to help.')}
    `),
  ).catch(err => console.error('[notifications] welcome email failed:', err));
}

// [NS-1] FIX: provider was typed as 'STRIPE' | 'MPESA' — 'PAYSTACK' was not in
// the union, causing TS2345 in paystack.webhook.routes.ts line 232.
// Now typed as PaymentProvider from @prisma/client (PAYSTACK | MPESA | MANUAL).
// providerLabel map updated: 'Stripe' → 'Paystack', MANUAL → 'Manual'.
export async function notifySubActivated(
  userId:   string,
  planName: string,
  provider: PaymentProvider,
): Promise<void> {
  const PROVIDER_LABEL: Record<PaymentProvider, string> = {
    PAYSTACK: 'Paystack',
    MPESA:    'M-Pesa',
    MANUAL:   'Manual',
  };
  const providerLabel = PROVIDER_LABEL[provider] ?? 'Paystack';

  await createNotification({
    userId,
    type:  'sub_activated',
    title: `${planName} Plan Activated!`,
    body:  `Your ${planName} subscription is now active via ${providerLabel}. Enjoy all premium features.`,
    link:  'subscription.html',
  });

  sendEmail(
    userId,
    `Your ${planName} plan is now active`,
    emailLayout(`${planName} activated`, `
      ${h1(`${planName} Plan Activated 🎉`)}
      ${p(`Your subscription is live. All ${planName} features are now unlocked.`)}
      ${infoBox([
        ['Plan',     planName],
        ['Payment',  providerLabel],
        ['Status',   'Active'],
      ])}
      ${ctaButton('Go to Dashboard', `${APP_URL}/dashboard.html`)}
    `),
  ).catch(err => console.error('[notifications] sub_activated email failed:', err));
}

export async function notifyTrialStarted(
  userId:    string,
  planName:  string,
  trialDays: number,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_trial',
    title: `Your ${planName} Trial Has Started`,
    body:  `You have ${trialDays} days to explore all ${planName} features free. Add a payment method to continue after the trial.`,
    link:  'subscription.html',
  });

  sendEmail(
    userId,
    `Your ${trialDays}-day ${planName} trial has started`,
    emailLayout(`${planName} trial started`, `
      ${h1(`Your Free Trial Is Live ⏳`)}
      ${p(`You have <strong style="color:#C9A84C;">${trialDays} days</strong> to explore every ${planName} feature — no charge until your trial ends.`)}
      ${infoBox([
        ['Plan',       planName],
        ['Trial days', String(trialDays)],
      ])}
      ${p('Add a payment method anytime before the trial ends to continue without interruption.')}
      ${ctaButton('Manage Subscription', `${APP_URL}/subscription.html`)}
    `),
  ).catch(err => console.error('[notifications] trial_started email failed:', err));
}

export async function notifyTrialEnding(
  userId:   string,
  planName: string,
  daysLeft: number,
): Promise<void> {
  const urgency = daysLeft <= 1 ? 'Your trial ends tomorrow!' : `Your trial ends in ${daysLeft} days.`;

  await createNotification({
    userId,
    type:  'sub_trial',
    title: `Trial Ending in ${daysLeft} Day${daysLeft === 1 ? '' : 's'}`,
    body:  `Your ${planName} trial ends soon. Upgrade now to keep your progress and premium access.`,
    link:  'subscription.html',
  });

  sendEmail(
    userId,
    `${urgency} Keep your ${planName} access`,
    emailLayout('Trial ending soon', `
      ${h1(`⏳ ${urgency}`)}
      ${p(`Your ${planName} free trial is almost over. Upgrade now to keep full access — your progress and settings are saved.`)}
      ${infoBox([
        ['Plan',      planName],
        ['Days left', String(daysLeft)],
      ])}
      ${ctaButton('Upgrade Now', `${APP_URL}/subscription.html`)}
      ${p('If you don\'t upgrade, your account will revert to the free plan when the trial ends.')}
    `),
  ).catch(err => console.error('[notifications] trial_ending email failed:', err));
}

export async function notifySubRenewed(
  userId:   string,
  planName: string,
  nextDate: string,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_renewed',
    title: 'Subscription Renewed',
    body:  `Your ${planName} subscription has been renewed. Next billing date: ${nextDate}.`,
    link:  'subscription.html',
  });

  sendEmail(
    userId,
    `Your ${planName} subscription has been renewed`,
    emailLayout('Subscription renewed', `
      ${h1('Subscription Renewed ✅')}
      ${p(`Your ${planName} plan has been successfully renewed. Thank you for staying with FlowFit!`)}
      ${infoBox([
        ['Plan',              planName],
        ['Next billing date', nextDate],
        ['Status',            'Active'],
      ])}
      ${ctaButton('View Subscription', `${APP_URL}/subscription.html`)}
    `),
  ).catch(err => console.error('[notifications] sub_renewed email failed:', err));
}

export async function notifyPaymentFailed(
  userId:   string,
  planName: string,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_failed',
    title: 'Payment Failed',
    body:  `We couldn't process your ${planName} payment. Please update your payment method to avoid losing access.`,
    link:  'subscription.html',
  });

  sendEmail(
    userId,
    `Action required: payment failed for ${planName}`,
    emailLayout('Payment failed', `
      ${h1('⚠️ Payment Failed')}
      ${p(`We were unable to process your payment for <strong style="color:#F0EBE0;">${planName}</strong>.
           Please update your payment method as soon as possible to keep your access uninterrupted.`)}
      ${ctaButton('Update Payment Method', `${APP_URL}/subscription.html`)}
      ${p('If payment is not resolved within a few days, your account may be downgraded to the free plan.')}
    `),
  ).catch(err => console.error('[notifications] payment_failed email failed:', err));
}

export async function notifySubCancelled(
  userId:    string,
  planName:  string,
  endDate:   string,
  immediate: boolean,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_cancelled',
    title: immediate ? 'Subscription Cancelled' : 'Cancellation Scheduled',
    body:  immediate
      ? `Your ${planName} subscription has been cancelled. You are now on the free plan.`
      : `Your ${planName} subscription will end on ${endDate}. You can reactivate anytime before then.`,
    link:  'subscription.html',
  });

  const subject = immediate
    ? `Your ${planName} subscription has been cancelled`
    : `Your ${planName} subscription ends on ${endDate}`;

  sendEmail(
    userId,
    subject,
    emailLayout('Subscription cancelled', immediate ? `
      ${h1('Subscription Cancelled 🚫')}
      ${p(`Your <strong style="color:#F0EBE0;">${planName}</strong> subscription has been cancelled and your account is now on the free plan.`)}
      ${p('Your workout history and progress data are preserved. You can resubscribe anytime.')}
      ${ctaButton('Resubscribe', `${APP_URL}/subscription.html`)}
    ` : `
      ${h1('Cancellation Scheduled')}
      ${p(`Your <strong style="color:#F0EBE0;">${planName}</strong> subscription is scheduled to end on
           <strong style="color:#C9A84C;">${endDate}</strong>.`)}
      ${p('You keep full access until that date. Changed your mind? You can reactivate before then.')}
      ${infoBox([
        ['Plan',         planName],
        ['Access until', endDate],
      ])}
      ${ctaButton('Reactivate Subscription', `${APP_URL}/subscription.html`)}
    `),
  ).catch(err => console.error('[notifications] sub_cancelled email failed:', err));
}

export async function notifySubExpired(
  userId:   string,
  planName: string,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_expired',
    title: `${planName} Plan Expired`,
    body:  'Your subscription has expired. Upgrade to regain access to premium features.',
    link:  'subscription.html',
  });

  sendEmail(
    userId,
    `Your ${planName} subscription has expired`,
    emailLayout('Subscription expired', `
      ${h1('⌛ Subscription Expired')}
      ${p(`Your <strong style="color:#F0EBE0;">${planName}</strong> subscription has expired.
           Your account is now on the free plan.`)}
      ${p('All your data is safe. Resubscribe to unlock premium features again.')}
      ${ctaButton('Resubscribe Now', `${APP_URL}/subscription.html`)}
    `),
  ).catch(err => console.error('[notifications] sub_expired email failed:', err));
}

export async function notifyMilestone(
  userId:  string,
  title:   string,
  body:    string,
  link?:   string,
): Promise<void> {
  await createNotification({ userId, type: 'milestone', title, body, link });

  sendEmail(
    userId,
    title,
    emailLayout(title, `
      ${h1(title)}
      ${p(body)}
      ${ctaButton('View Your Progress', `${APP_URL}/${link ?? 'progress.html'}`)}
    `),
  ).catch(err => console.error('[notifications] milestone email failed:', err));
}

export async function notifyAchievement(
  userId:      string,
  achievement: string,
  description: string,
): Promise<void> {
  await createNotification({
    userId,
    type:  'achievement',
    title: `Achievement Unlocked: ${achievement}`,
    body:  description,
    link:  'progress.html',
  });

  sendEmail(
    userId,
    `Achievement Unlocked: ${achievement}`,
    emailLayout(`Achievement: ${achievement}`, `
      ${h1(`🏆 Achievement Unlocked`)}
      <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#C9A84C;">${achievement}</p>
      ${p(description)}
      ${ctaButton('View All Achievements', `${APP_URL}/progress.html`)}
    `),
  ).catch(err => console.error('[notifications] achievement email failed:', err));
}

// ─── Read / Write operations ──────────────────────────────────────────────────

export async function getNotifications(
  userId:    string,
  limit      = 20,
  unreadOnly = false,
) {
  return prisma.notification.findMany({
    where: {
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take:    limit,
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, readAt: null },
  });
}

export async function markRead(
  userId:         string,
  notificationId: string,
): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data:  { readAt: new Date() },
  });
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data:  { readAt: new Date() },
  });
}

export async function deleteNotification(
  userId:         string,
  notificationId: string,
): Promise<void> {
  await prisma.notification.deleteMany({
    where: { id: notificationId, userId },
  });
}

// ─── Milestone checker — call after every workout log ────────────────────────

export async function checkAndNotifyMilestones(userId: string): Promise<void> {
  try {
    const [workoutCount, streak] = await Promise.all([
      prisma.workoutLog.count({ where: { userId } }),
      prisma.streak.findUnique({ where: { userId } }),
    ]);

    const milestones: Array<[number, string, string]> = [
      [1,   '🏁 First Workout Done!',       'You completed your very first workout. The hardest step is always the first.'],
      [5,   '⚡ 5 Workouts Complete',        'You\'ve logged 5 workouts. Consistency is building!'],
      [10,  '🔟 10 Workouts Milestone',      'Double digits! You\'re forming a real habit.'],
      [25,  '🥉 25 Workouts — Bronze Tier',  'A quarter century of workouts. You\'re committed!'],
      [50,  '🥈 50 Workouts — Silver Tier',  'Fifty workouts logged. You are well on your way.'],
      [100, '🥇 100 Workouts — Gold Tier',   'ONE HUNDRED workouts. You are an absolute legend.'],
    ];

    for (const [target, title, body] of milestones) {
      if (workoutCount === target) {
        const exists = await prisma.notification.findFirst({
          where: { userId, type: 'milestone', title },
        });
        if (!exists) {
          await notifyMilestone(userId, title, body, 'progress.html');
        }
      }
    }

    const streakMilestones: Array<[number, string, string]> = [
      [3,  '🔥 3-Day Streak!',  'Three days in a row — you\'re on fire!'],
      [7,  '🔥 7-Day Streak!',  'A full week of consistency. Incredible focus.'],
      [14, '🔥 2-Week Streak!', 'Fourteen days straight. You\'re unstoppable.'],
      [30, '🔥 30-Day Streak!', 'A month of daily workouts. That\'s elite-level discipline.'],
    ];

    const currentStreak = streak?.currentStreak ?? 0;
    for (const [target, title, body] of streakMilestones) {
      if (currentStreak === target) {
        const exists = await prisma.notification.findFirst({
          where: { userId, type: 'milestone', title },
        });
        if (!exists) {
          await notifyMilestone(userId, title, body, 'progress.html');
        }
      }
    }
  } catch (err) {
    console.error('[notifications] Milestone check failed:', err);
    // Non-critical — never block the workout log
  }
}
