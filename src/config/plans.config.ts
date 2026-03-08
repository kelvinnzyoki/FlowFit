// Seed data for the Plans table.
// Run: npx ts-node src/config/plans.seed.ts
// These are the defaults; production values come from the DB + Stripe dashboard.

export const PLAN_SEEDS = [
  {
    slug: 'free',
    name: 'Free',
    description: 'Get started with the basics.',
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    trialDays: 0,
    maxWorkoutsPerMonth: 10,
    maxPrograms: 1,
    hasAdvancedAnalytics: false,
    hasPersonalCoaching: false,
    hasNutritionTracking: false,
    hasOfflineAccess: false,
    features: [
      'Up to 10 workouts per month',
      '1 active program',
      'Basic progress tracking',
      'Exercise library access',
    ],
    displayOrder: 0,
    isActive: true,
    isPopular: false,
  },
  {
    slug: 'pro',
    name: 'Pro',
    description: 'Everything you need to crush your goals.',
    monthlyPriceCents: 1499,  // $14.99
    yearlyPriceCents:  11988, // $9.99/mo billed annually = $119.88
    trialDays: 14,
    maxWorkoutsPerMonth: null,       // unlimited
    maxPrograms: null,
    hasAdvancedAnalytics: true,
    hasPersonalCoaching: false,
    hasNutritionTracking: true,
    hasOfflineAccess: false,
    features: [
      'Unlimited workouts',
      'Unlimited programs',
      'Advanced analytics & charts',
      'Nutrition tracking',
      'Priority support',
      '14-day free trial',
    ],
    displayOrder: 1,
    isActive: true,
    isPopular: true,
  },
  {
    slug: 'elite',
    name: 'Elite',
    description: 'The complete performance platform.',
    monthlyPriceCents: 2999,  // $29.99
    yearlyPriceCents:  23988, // $19.99/mo billed annually = $239.88
    trialDays: 7,
    maxWorkoutsPerMonth: null,
    maxPrograms: null,
    hasAdvancedAnalytics: true,
    hasPersonalCoaching: true,
    hasNutritionTracking: true,
    hasOfflineAccess: true,
    features: [
      'Everything in Pro',
      'Personal AI coaching',
      'Offline access & sync',
      'Custom program builder',
      'Body composition analysis',
      'Dedicated account manager',
      '7-day free trial',
    ],
    displayOrder: 2,
    isActive: true,
    isPopular: false,
  },
];
