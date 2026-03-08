/**
 * FLOWFIT — Feature Gating Middleware
 *
 * Usage:
 *   router.get('/analytics', requireAuth, requirePlan('pro'), handler)
 *   router.get('/coaching',  requireAuth, requirePlan('elite'), handler)
 *
 * Security model:
 *   - Plan is always read from the DATABASE, never from a client-provided token
 *   - TRIALING users are allowed access (they have active trial)
 *   - PAST_DUE users get a grace period flag but are still allowed access
 *   - CANCELLED / EXPIRED users are blocked
 */

import { Request, Response, NextFunction } from 'express';
import { PrismaClient, SubscriptionStatus } from '@prisma/client';
import type { PlanSlug } from '../types/subscription.types.js';
import { PLAN_HIERARCHY, planMeetsRequirement } from '../types/subscription.types.js';

const prisma = new PrismaClient();

// Statuses that permit access to paid features
const ACTIVE_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING', 'PAST_DUE'];

/**
 * Middleware factory: gate a route behind a minimum plan requirement.
 *
 * @param requiredPlan - The minimum plan slug required ('pro' | 'elite')
 */
export function requirePlan(requiredPlan: PlanSlug) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      // Always fetch fresh from DB — never trust cached/token-based plan info
      const subscription = await prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: ACTIVE_STATUSES },
        },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });

      if (!subscription) {
        res.status(403).json({
          error: 'Subscription required',
          code: 'NO_SUBSCRIPTION',
          requiredPlan,
        });
        return;
      }

      const userPlanSlug = subscription.plan.slug as PlanSlug;

      if (!planMeetsRequirement(userPlanSlug, requiredPlan)) {
        res.status(403).json({
          error: `This feature requires the ${requiredPlan} plan or higher`,
          code: 'PLAN_INSUFFICIENT',
          currentPlan: userPlanSlug,
          requiredPlan,
          upgradeUrl: `/subscription.html`,
        });
        return;
      }

      // Attach subscription to request for use in the handler
      req.activeSubscription = {
        id: subscription.id,
        status: subscription.status,
        interval: subscription.interval,
        plan: {
          id: subscription.plan.id,
          slug: userPlanSlug,
          name: subscription.plan.name,
          description: subscription.plan.description,
          monthlyPriceCents: subscription.plan.monthlyPriceCents,
          yearlyPriceCents: subscription.plan.yearlyPriceCents,
          trialDays: subscription.plan.trialDays,
          maxWorkoutsPerMonth: subscription.plan.maxWorkoutsPerMonth,
          maxPrograms: subscription.plan.maxPrograms,
          hasAdvancedAnalytics: subscription.plan.hasAdvancedAnalytics,
          hasPersonalCoaching: subscription.plan.hasPersonalCoaching,
          hasNutritionTracking: subscription.plan.hasNutritionTracking,
          hasOfflineAccess: subscription.plan.hasOfflineAccess,
          features: Array.isArray(subscription.plan.features)
            ? subscription.plan.features as string[]
            : JSON.parse(subscription.plan.features as string),
          displayOrder: subscription.plan.displayOrder,
          isPopular: subscription.plan.isPopular,
        },
        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
        currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
        scheduledPlanSlug: null,
        activatedAt: subscription.activatedAt?.toISOString() ?? null,
        daysUntilRenewal: subscription.currentPeriodEnd
          ? Math.max(0, Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
          : null,
      };

      // Warn caller if payment is past due
      if (subscription.status === 'PAST_DUE') {
        res.setHeader('X-Subscription-Warning', 'PAST_DUE');
      }

      next();
    } catch (err) {
      console.error('[requirePlan] DB error:', err);
      res.status(500).json({ error: 'Failed to verify subscription' });
    }
  };
}

/**
 * Soft gate: attach subscription info but don't block.
 * Use on routes where behaviour varies by plan but access isn't fully restricted.
 */
export function loadSubscription() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) { next(); return; }

    try {
      const subscription = await prisma.subscription.findFirst({
        where: { userId, status: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });

      if (subscription) {
        req.activeSubscription = {
          id: subscription.id,
          status: subscription.status,
          interval: subscription.interval,
          plan: {
            id: subscription.plan.id,
            slug: subscription.plan.slug as PlanSlug,
            name: subscription.plan.name,
            description: subscription.plan.description,
            monthlyPriceCents: subscription.plan.monthlyPriceCents,
            yearlyPriceCents: subscription.plan.yearlyPriceCents,
            trialDays: subscription.plan.trialDays,
            maxWorkoutsPerMonth: subscription.plan.maxWorkoutsPerMonth,
            maxPrograms: subscription.plan.maxPrograms,
            hasAdvancedAnalytics: subscription.plan.hasAdvancedAnalytics,
            hasPersonalCoaching: subscription.plan.hasPersonalCoaching,
            hasNutritionTracking: subscription.plan.hasNutritionTracking,
            hasOfflineAccess: subscription.plan.hasOfflineAccess,
            features: Array.isArray(subscription.plan.features)
              ? subscription.plan.features as string[]
              : JSON.parse(subscription.plan.features as string),
            displayOrder: subscription.plan.displayOrder,
            isPopular: subscription.plan.isPopular,
          },
          trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
          currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
          scheduledPlanSlug: null,
          activatedAt: subscription.activatedAt?.toISOString() ?? null,
          daysUntilRenewal: subscription.currentPeriodEnd
            ? Math.max(0, Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
            : null,
        };
      }
      next();
    } catch { next(); }
  };
}
