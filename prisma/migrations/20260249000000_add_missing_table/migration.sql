-- Fix: updatedAt has no DEFAULT on the existing plans table.
-- Set the default first, then the INSERT will populate it automatically.

ALTER TABLE plans
  ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
  ALTER COLUMN "createdAt" SET DEFAULT NOW();

-- Re-run the seed (safe — ON CONFLICT DO NOTHING skips existing rows)
INSERT INTO plans (
  id, slug, name, description,
  "monthlyPriceCents", "yearlyPriceCents",
  "mpesaMonthlyKes",   "mpesaYearlyKes",
  "paystackPlanCodeMonthly", "paystackPlanCodeYearly",
  "trialDays", "maxWorkoutsPerMonth", "maxPrograms",
  "hasAdvancedAnalytics", "hasPersonalCoaching",
  "hasNutritionTracking", "hasOfflineAccess",
  features, "displayOrder", "isActive", "isPopular",
  "createdAt", "updatedAt"
)
VALUES
  (
    gen_random_uuid()::TEXT, 'free', 'Free', 'Get started with the basics.',
    0, 0, 0, 0, NULL, NULL, 0, 10, 1,
    FALSE, FALSE, FALSE, FALSE,
    '["Up to 10 workouts per month","1 active program","Basic progress tracking","Exercise library access"]',
    0, TRUE, FALSE, NOW(), NOW()
  ),
  (
    gen_random_uuid()::TEXT, 'pro', 'Pro', 'Everything you need to crush your goals.',
    1499, 11988, 1950, 15600, NULL, NULL, 14, NULL, NULL,
    TRUE, FALSE, TRUE, FALSE,
    '["Unlimited workouts","Unlimited programs","Advanced analytics & charts","Nutrition tracking","Priority support","14-day free trial"]',
    1, TRUE, TRUE, NOW(), NOW()
  ),
  (
    gen_random_uuid()::TEXT, 'elite', 'Elite', 'The complete performance platform.',
    2999, 23988, 3900, 31200, NULL, NULL, 7, NULL, NULL,
    TRUE, TRUE, TRUE, TRUE,
    '["Everything in Pro","Personal AI coaching","Offline access & sync","Custom program builder","Body composition analysis","Dedicated account manager"]',
    2, TRUE, FALSE, NOW(), NOW()
  )
ON CONFLICT (slug) DO NOTHING;
