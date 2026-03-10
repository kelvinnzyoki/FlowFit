/**
 * Seed the plans table.
 * Run: npx ts-node --esm src/config/plans.seed.ts
 *
 * Safe to run multiple times — uses upsert on slug.
 */

import { PrismaClient } from '@prisma/client';
import { PLAN_SEEDS } from '../src/config/plans.config.ts';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding plans...');

  for (const plan of PLAN_SEEDS) {
    const upserted = await prisma.plan.upsert({
      where: { slug: plan.slug },
      create: { ...plan, features: plan.features as any },
      update: { ...plan, features: plan.features as any },
    });
    console.log(`  ✓ ${upserted.slug} — ${upserted.name} (id: ${upserted.id})`);
  }

  console.log('\nPlans seeded. Copy the IDs above and create matching Stripe products:');
  console.log('  1. Create products in Stripe Dashboard');
  console.log('  2. Create recurring prices (monthly + yearly) for each paid plan');
  console.log('  3. Update stripePriceIdMonthly / stripePriceIdYearly in the plans table');
  console.log('  4. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
