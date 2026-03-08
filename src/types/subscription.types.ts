export type PlanSlug = 'free' | 'pro' | 'elite';

export const PLAN_HIERARCHY: Record<PlanSlug, number> = {
  free:  0,
  pro:   1,
  elite: 2,
};

export function planMeetsRequirement(current: PlanSlug, required: PlanSlug): boolean {
  return PLAN_HIERARCHY[current] >= PLAN_HIERARCHY[required];
}

export interface PublicPlan {
  id: string;
  slug: PlanSlug;
  name: string;
  description: string | null;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  trialDays: number;
  maxWorkoutsPerMonth: number | null;
  maxPrograms: number | null;
  hasAdvancedAnalytics: boolean;
  hasPersonalCoaching: boolean;
  hasNutritionTracking: boolean;
  hasOfflineAccess: boolean;
  features: string[];
  displayOrder: number;
  isPopular: boolean;
}

export interface CurrentSubscription {
  id: string;
  status: string;
  interval: string;
  plan: PublicPlan;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  scheduledPlanSlug: string | null;
  activatedAt: string | null;
  daysUntilRenewal: number | null;
}

export interface CheckoutRequest {
  planId: string;
  interval: 'MONTHLY' | 'YEARLY';
}

export interface CancelRequest {
  immediately?: boolean;
  reason?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  stripeCustomerId?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      activeSubscription?: CurrentSubscription | null;
    }
  }
}
