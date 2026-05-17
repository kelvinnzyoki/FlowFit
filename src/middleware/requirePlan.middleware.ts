import { Request, Response, NextFunction } from 'express';
import { SubscriptionStatus } from '@prisma/client';
import prisma from '../config/db.js';
import type { PlanSlug } from '../types/subscription.types.js';
import { planMeetsRequirement } from '../types/subscription.types.js';

const ACTIVE_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING', 'PAST_DUE'];

// Gate a route behind a minimum plan — usage: router.get('/route', requireAuth, requirePlan('pro'), handler)
export function requirePlan(requiredPlan: PlanSlug) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    try {
      const subscription = await prisma.subscription.findFirst({
        where:   { userId, status: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });

      if (!subscription) {
        res.status(403).json({ error: 'Subscription required.', code: 'NO_SUBSCRIPTION', requiredPlan });
        return;
      }

      const userPlanSlug = subscription.plan.slug as PlanSlug;
      if (!planMeetsRequirement(userPlanSlug, requiredPlan)) {
        res.status(403).json({
          error:      `This feature requires the ${requiredPlan} plan or higher.`,
          code:       'PLAN_INSUFFICIENT',
          currentPlan: userPlanSlug,
          requiredPlan,
          upgradeUrl: '/subscription',
        });
        return;
      }

      req.activeSubscription = buildSubscriptionPayload(subscription);

      if (subscription.status === 'PAST_DUE') {
        res.setHeader('X-Subscription-Warning', 'PAST_DUE');
      }

      next();
    } catch (err) {
      console.error('[requirePlan] DB error:', err);
      res.status(500).json({ error: 'Failed to verify subscription.' });
    }
  };
}

// Soft gate: attach subscription info without blocking — use where behaviour varies by plan
export function loadSubscription() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) { next(); return; }
    try {
      const subscription = await prisma.subscription.findFirst({
        where:   { userId, status: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });
      if (subscription) req.activeSubscription = buildSubscriptionPayload(subscription);
      next();
    } catch { next(); }
  };
}


function parsePlanFeatures(features: unknown): string[] {
  if (Array.isArray(features)) return features.map(String);
  if (features && typeof features === 'object') return Object.values(features as Record<string, unknown>).map(String);
  if (typeof features !== 'string' || !features.trim()) return [];

  try {
    const parsed = JSON.parse(features);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>).map(String);
    return [];
  } catch {
    return [];
  }
}

function buildSubscriptionPayload(subscription: any) {
  return {
    id:       subscription.id,
    status:   subscription.status,
    interval: subscription.interval,
    plan: {
      id:                    subscription.plan.id,
      slug:                  subscription.plan.slug as PlanSlug,
      name:                  subscription.plan.name,
      description:           subscription.plan.description,
      monthlyPriceCents:     subscription.plan.monthlyPriceCents,
      yearlyPriceCents:      subscription.plan.yearlyPriceCents,
      trialDays:             subscription.plan.trialDays,
      maxWorkoutsPerMonth:   subscription.plan.maxWorkoutsPerMonth,
      maxPrograms:           subscription.plan.maxPrograms,
      hasAdvancedAnalytics:  subscription.plan.hasAdvancedAnalytics,
      hasPersonalCoaching:   subscription.plan.hasPersonalCoaching,
      hasNutritionTracking:  subscription.plan.hasNutritionTracking,
      hasOfflineAccess:      subscription.plan.hasOfflineAccess,
      features: parsePlanFeatures(subscription.plan.features),
      displayOrder: subscription.plan.displayOrder,
      isPopular:    subscription.plan.isPopular,
    },
    trialEndsAt:         subscription.trialEndsAt?.toISOString()         ?? null,
    currentPeriodStart:  subscription.currentPeriodStart?.toISOString()  ?? null,
    currentPeriodEnd:    subscription.currentPeriodEnd?.toISOString()    ?? null,
    cancelAtPeriodEnd:   subscription.cancelAtPeriodEnd,
    cancelledAt:         subscription.cancelledAt?.toISOString()         ?? null,
    scheduledPlanSlug:   null,
    activatedAt:         subscription.activatedAt?.toISOString()         ?? null,
    daysUntilRenewal:    subscription.currentPeriodEnd
      ? Math.max(0, Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
      : null,
  };
}
