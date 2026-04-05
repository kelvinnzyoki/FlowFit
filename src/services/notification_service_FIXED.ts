/**
 * FLOWFIT — Notification Service
 *
 * Creates, fetches, and manages in-app notifications.
 * Called by:
 *   - auth_routes.ts  → welcome message on first login
 *   - subscription webhook handlers → plan activated / cancelled / trial ending
 *   - progress_routes.ts → milestone unlocked
 *   - cron jobs → subscription reminders
 *
 * Notification types:
 *   welcome        New user joined
 *   sub_activated  Plan went ACTIVE (Stripe or M-Pesa)
 *   sub_trial      Trial started or N days remaining
 *   sub_expired    Trial/plan expired
 *   sub_cancelled  Cancellation scheduled or immediate
 *   sub_renewed    Payment succeeded / period renewed
 *   sub_failed     Payment failed / PAST_DUE
 *   milestone      Progress achievement (streak, workouts, calories)
 *   achievement    Badge unlocked
 *   system         Generic platform message
 */

import prisma from '../config/db.js';

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

// ─── Default icons per type ───────────────────────────────────────────────────
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

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
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

// ─── Convenience factories ────────────────────────────────────────────────────

export async function notifyWelcome(userId: string, name: string): Promise<void> {
  await createNotification({
    userId,
    type:  'welcome',
    title: `Welcome to FlowFit, ${name}! 🎉`,
    body:  'Your fitness journey starts today. Explore workouts, track your progress, and crush your goals.',
    link:  'workouts.html',
  });
}

export async function notifySubActivated(
  userId:   string,
  planName: string,
  provider: 'STRIPE' | 'MPESA',
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_activated',
    title: `${planName} Plan Activated!`,
    body:  `Your ${planName} subscription is now active via ${provider === 'MPESA' ? 'M-Pesa' : 'Stripe'}. Enjoy all premium features.`,
    link:  'subscription.html',
  });
}

export async function notifyTrialStarted(
  userId:      string,
  planName:    string,
  trialDays:   number,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_trial',
    title: `Your ${planName} Trial Has Started`,
    body:  `You have ${trialDays} days to explore all ${planName} features free. Add a payment method to continue after the trial.`,
    link:  'subscription.html',
  });
}

export async function notifyTrialEnding(
  userId:    string,
  planName:  string,
  daysLeft:  number,
): Promise<void> {
  await createNotification({
    userId,
    type:  'sub_trial',
    title: `Trial Ending in ${daysLeft} Day${daysLeft === 1 ? '' : 's'}`,
    body:  `Your ${planName} trial ends soon. Upgrade now to keep your progress and premium access.`,
    link:  'subscription.html',
  });
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
}

export async function notifyMilestone(
  userId:  string,
  title:   string,
  body:    string,
  link?:   string,
): Promise<void> {
  await createNotification({ userId, type: 'milestone', title, body, link });
}

export async function notifyAchievement(
  userId:       string,
  achievement:  string,
  description:  string,
): Promise<void> {
  await createNotification({
    userId,
    type:  'achievement',
    title: `Achievement Unlocked: ${achievement}`,
    body:  description,
    link:  'progress.html',
  });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getNotifications(
  userId:  string,
  limit    = 20,
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

// ─── Milestone checker — call after every workout log ─────────────────────────

export async function checkAndNotifyMilestones(userId: string): Promise<void> {
  try {
    const [workoutCount, streak] = await Promise.all([
      prisma.workoutLog.count({ where: { userId } }),
      prisma.streak.findUnique({ where: { userId } }),
    ]);

    const milestones: Array<[number, string, string]> = [
      [1,   '🏁 First Workout Done!',         'You completed your very first workout. The hardest step is always the first.'],
      [5,   '⚡ 5 Workouts Complete',          'You\'ve logged 5 workouts. Consistency is building!'],
      [10,  '🔟 10 Workouts Milestone',         'Double digits! You\'re forming a real habit.'],
      [25,  '🥉 25 Workouts — Bronze Tier',     'A quarter century of workouts. You\'re committed!'],
      [50,  '🥈 50 Workouts — Silver Tier',     'Fifty workouts logged. You are well on your way.'],
      [100, '🥇 100 Workouts — Gold Tier',      'ONE HUNDRED workouts. You are an absolute legend.'],
    ];

    for (const [target, title, body] of milestones) {
      if (workoutCount === target) {
        // Check not already notified for this milestone
        const exists = await prisma.notification.findFirst({
          where: { userId, type: 'milestone', title },
        });
        if (!exists) {
          await notifyMilestone(userId, title, body, 'progress.html');
        }
      }
    }

    // Streak milestones
    const streakMilestones: Array<[number, string, string]> = [
      [3,  '🔥 3-Day Streak!',    'Three days in a row — you\'re on fire!'],
      [7,  '🔥 7-Day Streak!',    'A full week of consistency. Incredible focus.'],
      [14, '🔥 2-Week Streak!',   'Fourteen days straight. You\'re unstoppable.'],
      [30, '🔥 30-Day Streak!',   'A month of daily workouts. That\'s elite-level discipline.'],
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
