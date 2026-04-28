/**
 * FLOWFIT — Subscription Types (v3)
 *
 * Migration: Stripe → Paystack.
 *
 * Field changes on CurrentSubscription:
 *   REMOVED  stripeSubscriptionId   — no equivalent single-field concept in Paystack
 *   ADDED    paystackSubscriptionCode — subscription_code returned by Paystack on first charge;
 *                                       used to enable / disable the subscription via API.
 *   ADDED    paystackEmailToken       — email_token returned alongside subscription_code;
 *                                       required by Paystack disable/enable endpoints.
 *
 * Field changes on AuthenticatedUser:
 *   REMOVED  stripeCustomerId   — Paystack creates/retrieves customers automatically per email.
 *   ADDED    paystackCustomerCode — customer_code returned by Paystack; stored for reference
 *                                   and for subscription management calls.
 *
 * DB schema fields that changed (update your Prisma schema accordingly):
 *   Plan model:
 *     stripePriceIdMonthly  → paystackPlanCodeMonthly
 *     stripePriceIdYearly   → paystackPlanCodeYearly
 *   Subscription model:
 *     stripeCheckoutSessionId → paystackReference         (transaction reference)
 *     stripeSubscriptionId    → paystackSubscriptionCode  (set after first successful charge)
 *                             + paystackEmailToken        (set at same time)
 *   User model:
 *     stripeCustomerId        → paystackCustomerCode
 */

export type PlanSlug = 'free' | 'pro' | 'elite';

export const PLAN_HIERARCHY: Record<PlanSlug, number> = {
  free:  0,
  pro:   1,
  elite: 2,
};

export function planMeetsRequirement(
  current:  PlanSlug,
  required: PlanSlug,
): boolean {
  return PLAN_HIERARCHY[current] >= PLAN_HIERARCHY[required];
}

export interface PublicPlan {
  id:                   string;
  slug:                 PlanSlug;
  name:                 string;
  description:          string | null;
  monthlyPriceCents:    number;
  yearlyPriceCents:     number;
  trialDays:            number;
  maxWorkoutsPerMonth:  number | null;
  maxPrograms:          number | null;
  hasAdvancedAnalytics: boolean;
  hasPersonalCoaching:  boolean;
  hasNutritionTracking: boolean;
  hasOfflineAccess:     boolean;
  features:             string[];
  displayOrder:         number;
  isPopular:            boolean;
}

export interface CurrentSubscription {
  id:                      string;
  status:                  string;
  interval:                string;
  plan:                    PublicPlan;
  trialEndsAt:             string | null;
  currentPeriodStart:      string | null;
  currentPeriodEnd:        string | null;
  cancelAtPeriodEnd:       boolean;
  cancelledAt:             string | null;
  scheduledPlanSlug:       string | null;
  activatedAt:             string | null;
  daysUntilRenewal:        number | null;
  /**
   * Paystack subscription_code — present once the first charge succeeds and
   * Paystack creates a subscription object. Null for M-Pesa subscriptions,
   * abandoned INCOMPLETE checkouts, and free-trial subs where no card was charged.
   *
   * Used with paystackEmailToken to call:
   *   POST https://api.paystack.co/subscription/disable
   *   POST https://api.paystack.co/subscription/enable
   */
  paystackSubscriptionCode: string | null;
  /**
   * Paystack email_token — returned alongside paystackSubscriptionCode.
   * Required as the second authentication factor when managing a subscription
   * via the Paystack API (disable / enable).
   */
  paystackEmailToken:       string | null;
}

export interface CheckoutRequest {
  planId:      string;
  interval:    'MONTHLY' | 'YEARLY';
  successUrl?: string;
  cancelUrl?:  string;
}

export interface CancelRequest {
  immediately?: boolean;
  reason?:      string;
}

export interface AuthenticatedUser {
  id:                   string;
  email:                string;
  role:                 string;
  /**
   * Paystack customer_code — stored after the first Paystack transaction so
   * future API calls (subscription management, charge history) can reference
   * the customer without re-fetching by email. May be null for users who have
   * only ever used M-Pesa or have no subscription history.
   */
  paystackCustomerCode?: string | null;
}
