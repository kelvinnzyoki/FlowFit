import { Router, Request, Response, NextFunction } from 'express';
import { Prisma, FeedbackStatus, SubscriptionStatus } from '@prisma/client';
import prisma from '../config/db.js';
import { requireAdmin } from '../middleware/requireAdmin.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticate, requireAdmin);

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pageArgs(req: Request) {
  const page = Math.max(1, asInt(req.query.page, 1));
  const limit = Math.min(PAGE_SIZE_MAX, asInt(req.query.limit, PAGE_SIZE_DEFAULT));
  return {
    page,
    limit,
    skip: (page - 1) * limit,
    take: limit,
  };
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function thirtyDaysAgo(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

function safeString(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  return s || undefined;
}

function parseFeedbackStatus(value: unknown): FeedbackStatus | null {
  const raw = String(value ?? '').trim().toUpperCase();
  if (['NEW', 'REVIEWED', 'RESOLVED', 'DISMISSED'].includes(raw)) {
    return raw as FeedbackStatus;
  }
  return null;
}

router.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = startOfToday();
    const recentWindow = thirtyDaysAgo();

    const [
      totalUsers,
      newUsersToday,
      verifiedUsers,
      totalPrograms,
      activePrograms,
      totalEnrollments,
      activeEnrollments,
      totalWorkoutLogs,
      workoutsToday,
      feedbackNew,
      feedbackTotal,
      totalPayments,
      successfulPayments,
      subscriptionStatusCounts,
      subscriptionPlanCounts,
      recentUsers,
      recentSubscriptions,
      recentFeedback,
      recentWorkouts,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.user.count({ where: { isEmailVerified: true } }),
      prisma.program.count(),
      prisma.program.count({ where: { isActive: true } }),
      prisma.programEnrollment.count(),
      prisma.programEnrollment.count({ where: { isActive: true } }),
      prisma.workoutLog.count(),
      prisma.workoutLog.count({ where: { createdAt: { gte: today } } }),
      prisma.feedback.count({ where: { status: 'NEW' } }),
      prisma.feedback.count(),
      prisma.payment.aggregate({
        _sum: { amountCents: true },
      }),
      prisma.payment.aggregate({
        where: { status: { in: ['success', 'SUCCESS', 'paid', 'PAID', 'succeeded', 'SUCCEEDED'] } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      prisma.subscription.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.subscription.groupBy({
        by: ['planId'],
        _count: { _all: true },
      }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isEmailVerified: true,
          lastLogin: true,
          createdAt: true,
        },
      }),
      prisma.subscription.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          user: { select: { id: true, name: true, email: true } },
          plan: { select: { id: true, slug: true, name: true } },
        },
      }),
      prisma.feedback.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.workoutLog.findMany({
        where: { createdAt: { gte: recentWindow } },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          user: { select: { id: true, name: true, email: true } },
          exercise: { select: { id: true, name: true, category: true } },
        },
      }),
    ]);

    const plans = await prisma.plan.findMany({
      select: { id: true, slug: true, name: true },
    });
    const planMap = new Map(plans.map(plan => [plan.id, plan]));

    const statusBreakdown = subscriptionStatusCounts.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    const planBreakdown = subscriptionPlanCounts.reduce<Record<string, number>>((acc, row) => {
      const plan = planMap.get(row.planId);
      const key = plan?.slug || row.planId;
      acc[key] = row._count._all;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totals: {
          users: totalUsers,
          newUsersToday,
          verifiedUsers,
          programs: totalPrograms,
          activePrograms,
          enrollments: totalEnrollments,
          activeEnrollments,
          workoutLogs: totalWorkoutLogs,
          workoutsToday,
          feedbackNew,
          feedbackTotal,
          revenueCents: successfulPayments._sum.amountCents || 0,
          paymentCount: successfulPayments._count._all || 0,
          grossPaymentVolumeCents: totalPayments._sum.amountCents || 0,
        },
        subscriptions: {
          byStatus: statusBreakdown,
          byPlan: planBreakdown,
        },
        recent: {
          users: recentUsers,
          subscriptions: recentSubscriptions,
          feedback: recentFeedback,
          workouts: recentWorkouts,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip, take } = pageArgs(req);
    const q = safeString(req.query.q);

    const where: Prisma.UserWhereInput = q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isEmailVerified: true,
          phoneVerified: true,
          lastLogin: true,
          createdAt: true,
          updatedAt: true,
          subscriptions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              interval: true,
              currentPeriodEnd: true,
              cancelAtPeriodEnd: true,
              plan: { select: { slug: true, name: true } },
            },
          },
          _count: {
            select: {
              workoutLogs: true,
              enrollments: true,
              feedback: true,
              notifications: true,
            },
          },
        },
      }),
    ]);

    res.json({ success: true, data: { page, limit, total, users } });
  } catch (err) {
    next(err);
  }
});

router.get('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip, take } = pageArgs(req);
    const status = safeString(req.query.status)?.toUpperCase();
    const planSlug = safeString(req.query.plan)?.toLowerCase();

    const where: Prisma.SubscriptionWhereInput = {};
    if (status && Object.values(SubscriptionStatus).includes(status as SubscriptionStatus)) {
      where.status = status as SubscriptionStatus;
    }
    if (planSlug) {
      where.plan = { slug: planSlug };
    }

    const [total, subscriptions] = await Promise.all([
      prisma.subscription.count({ where }),
      prisma.subscription.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          plan: { select: { id: true, slug: true, name: true } },
          payments: {
            orderBy: { createdAt: 'desc' },
            take: 3,
            select: {
              id: true,
              provider: true,
              amountCents: true,
              currency: true,
              status: true,
              paidAt: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    res.json({ success: true, data: { page, limit, total, subscriptions } });
  } catch (err) {
    next(err);
  }
});

router.get('/workouts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip, take } = pageArgs(req);
    const q = safeString(req.query.q);

    const where: Prisma.WorkoutLogWhereInput = q
      ? {
          OR: [
            { user: { email: { contains: q, mode: 'insensitive' } } },
            { user: { name: { contains: q, mode: 'insensitive' } } },
            { exercise: { name: { contains: q, mode: 'insensitive' } } },
            { exercise: { category: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {};

    const [total, workouts] = await Promise.all([
      prisma.workoutLog.count({ where }),
      prisma.workoutLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          exercise: { select: { id: true, name: true, category: true } },
        },
      }),
    ]);

    res.json({ success: true, data: { page, limit, total, workouts } });
  } catch (err) {
    next(err);
  }
});

router.get('/program-enrollments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip, take } = pageArgs(req);
    const active = String(req.query.active ?? '').toLowerCase();

    const where: Prisma.ProgramEnrollmentWhereInput = {};
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;

    const [total, enrollments] = await Promise.all([
      prisma.programEnrollment.count({ where }),
      prisma.programEnrollment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          program: { select: { id: true, name: true, difficulty: true, durationWeeks: true } },
        },
      }),
    ]);

    res.json({ success: true, data: { page, limit, total, enrollments } });
  } catch (err) {
    next(err);
  }
});

router.get('/programs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip, take } = pageArgs(req);
    const q = safeString(req.query.q);

    const where: Prisma.ProgramWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { category: { contains: q, mode: 'insensitive' } },
            { difficulty: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [total, programs] = await Promise.all([
      prisma.program.count({ where }),
      prisma.program.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          _count: { select: { enrollments: true, weeks: true } },
        },
      }),
    ]);

    res.json({ success: true, data: { page, limit, total, programs } });
  } catch (err) {
    next(err);
  }
});

router.get('/feedback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, skip, take } = pageArgs(req);
    const status = parseFeedbackStatus(req.query.status);

    const where: Prisma.FeedbackWhereInput = status ? { status } : {};

    const [total, feedback] = await Promise.all([
      prisma.feedback.count({ where }),
      prisma.feedback.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    res.json({ success: true, data: { page, limit, total, feedback } });
  } catch (err) {
    next(err);
  }
});

router.patch('/feedback/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = parseFeedbackStatus(req.body?.status);
    if (!status) {
      res.status(400).json({ success: false, error: 'Invalid feedback status.' });
      return;
    }

    const feedback = await prisma.feedback.update({
      where: { id: req.params.id },
      data: { status },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ success: true, data: { feedback } });
  } catch (err: any) {
    if (err?.code === 'P2025') {
      res.status(404).json({ success: false, error: 'Feedback not found.' });
      return;
    }
    next(err);
  }
});

router.get('/activity', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [users, subscriptions, workouts, enrollments, feedback, payments, logs] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, name: true, email: true, createdAt: true },
      }),
      prisma.subscription.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 10,
        include: {
          user: { select: { id: true, name: true, email: true } },
          plan: { select: { slug: true, name: true } },
        },
      }),
      prisma.workoutLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: { select: { id: true, name: true, email: true } },
          exercise: { select: { name: true } },
        },
      }),
      prisma.programEnrollment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: { select: { id: true, name: true, email: true } },
          program: { select: { name: true } },
        },
      }),
      prisma.feedback.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.payment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          subscription: {
            include: {
              user: { select: { id: true, name: true, email: true } },
              plan: { select: { slug: true, name: true } },
            },
          },
        },
      }),
      prisma.subscriptionLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          subscription: {
            include: {
              user: { select: { id: true, name: true, email: true } },
              plan: { select: { slug: true, name: true } },
            },
          },
        },
      }),
    ]);

    const activity = [
      ...users.map(u => ({
        type: 'USER_CREATED',
        label: 'New user registered',
        message: `${u.name || u.email} joined FlowFit`,
        createdAt: u.createdAt,
        meta: { userId: u.id, email: u.email },
      })),
      ...subscriptions.map(s => ({
        type: 'SUBSCRIPTION_UPDATED',
        label: `Subscription ${s.status}`,
        message: `${s.user.email} · ${s.plan.name} (${s.interval})`,
        createdAt: s.updatedAt,
        meta: { subscriptionId: s.id, userId: s.userId, plan: s.plan.slug },
      })),
      ...workouts.map(w => ({
        type: 'WORKOUT_LOGGED',
        label: 'Workout logged',
        message: `${w.user.email} logged ${w.exercise.name}`,
        createdAt: w.createdAt,
        meta: { workoutLogId: w.id, userId: w.userId },
      })),
      ...enrollments.map(e => ({
        type: 'PROGRAM_ENROLLED',
        label: 'Program enrollment',
        message: `${e.user.email} enrolled in ${e.program.name}`,
        createdAt: e.createdAt,
        meta: { enrollmentId: e.id, userId: e.userId, programId: e.programId },
      })),
      ...feedback.map(f => ({
        type: 'FEEDBACK',
        label: `Feedback: ${f.status}`,
        message: `${f.user.email} · ${f.type}`,
        createdAt: f.createdAt,
        meta: { feedbackId: f.id, userId: f.userId },
      })),
      ...payments.map(p => ({
        type: 'PAYMENT',
        label: `Payment ${p.status}`,
        message: `${p.subscription.user.email} · ${p.currency} ${(p.amountCents / 100).toFixed(2)}`,
        createdAt: p.createdAt,
        meta: { paymentId: p.id, subscriptionId: p.subscriptionId },
      })),
      ...logs.map(l => ({
        type: 'SUBSCRIPTION_LOG',
        label: String(l.event),
        message: `${l.subscription.user.email} · ${l.subscription.plan.name}`,
        createdAt: l.createdAt,
        meta: { logId: l.id, subscriptionId: l.subscriptionId },
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 40);

    res.json({ success: true, data: { activity } });
  } catch (err) {
    next(err);
  }
});

export default router;
