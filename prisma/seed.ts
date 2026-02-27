/**
 * FlowFit Database Seed — matches exact schema.prisma
 * 
 * HOW TO RUN:
 *   Option A (add to package.json first):
 *     npx prisma db seed
 *
 *   Option B (direct):
 *     npx ts-node prisma/seed.ts
 *
 * Add to package.json:
 *   "prisma": { "seed": "ts-node prisma/seed.ts" }
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding FlowFit database...\n');

  // ────────────────────────────────────────────────────────────────────────────
  // 1. EXERCISES  (matches Exercise model exactly)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('→ Seeding exercises...');

  const exerciseData = [
    // STRENGTH
    { id: 'ex-pushup',  name: 'Push-ups',          category: 'STRENGTH',    caloriesPerMin: 8.0,  description: 'Classic upper body exercise targeting chest, shoulders, and triceps. Keep body straight, lower chest to the floor.' },
    { id: 'ex-squat',   name: 'Squats',             category: 'STRENGTH',    caloriesPerMin: 9.0,  description: 'Fundamental lower body movement for building leg strength and power. Keep chest up, knees tracking over toes.' },
    { id: 'ex-lunge',   name: 'Lunges',             category: 'STRENGTH',    caloriesPerMin: 7.5,  description: 'Unilateral leg exercise that improves balance, coordination, and lower body strength.' },
    { id: 'ex-dips',    name: 'Tricep Dips',        category: 'STRENGTH',    caloriesPerMin: 7.0,  description: 'Bodyweight exercise targeting the triceps, chest, and anterior deltoids using a chair or bench.' },
    { id: 'ex-glute',   name: 'Glute Bridges',      category: 'STRENGTH',    caloriesPerMin: 6.0,  description: 'Hip extension exercise activating glutes and hamstrings. Drive hips toward the ceiling from lying down.' },
    { id: 'ex-pike',    name: 'Pike Push-ups',       category: 'STRENGTH',    caloriesPerMin: 8.5,  description: 'Advanced shoulder exercise. Form an inverted V and lower your head toward the floor.' },
    // CARDIO
    { id: 'ex-burpee',  name: 'Burpees',            category: 'CARDIO',      caloriesPerMin: 12.0, description: 'High-intensity full-body exercise combining a squat, push-up, and jump. One of the best calorie burners.' },
    { id: 'ex-jjack',   name: 'Jumping Jacks',      category: 'CARDIO',      caloriesPerMin: 8.0,  description: 'Classic full-body cardio warm-up. Elevates heart rate and improves coordination. Great for all levels.' },
    { id: 'ex-hknees',  name: 'High Knees',         category: 'CARDIO',      caloriesPerMin: 10.0, description: 'Running in place while driving knees up to hip level. Excellent cardio and hip flexor activation.' },
    { id: 'ex-bkicks',  name: 'Butt Kicks',         category: 'CARDIO',      caloriesPerMin: 9.0,  description: 'Jogging in place while kicking heels toward glutes. Improves hamstring flexibility and cardio fitness.' },
    // CORE
    { id: 'ex-plank',   name: 'Plank',              category: 'CORE',        caloriesPerMin: 5.0,  description: 'Isometric core exercise building full-body endurance and stability. Hold a push-up position on forearms.' },
    { id: 'ex-mclimb',  name: 'Mountain Climbers',  category: 'CORE',        caloriesPerMin: 11.0, description: 'Dynamic core and cardio exercise. From plank, alternate driving knees toward your chest at speed.' },
    { id: 'ex-crunch',  name: 'Crunches',           category: 'CORE',        caloriesPerMin: 5.5,  description: 'Classic abdominal exercise targeting the rectus abdominis. Lie on back, knees bent, curl upper body up.' },
    { id: 'ex-rtwist',  name: 'Russian Twists',     category: 'CORE',        caloriesPerMin: 6.5,  description: 'Rotational core exercise targeting obliques. Sit with feet elevated, lean back, and rotate side to side.' },
    { id: 'ex-lraise',  name: 'Leg Raises',         category: 'CORE',        caloriesPerMin: 5.0,  description: 'Lower ab exercise. Lie flat, raise straight legs to 90° then slowly lower without touching the floor.' },
    // HIIT
    { id: 'ex-sqjmp',   name: 'Jump Squats',        category: 'HIIT',        caloriesPerMin: 14.0, description: 'Explosive plyometric squat. Squat down then explode upward into a jump, landing softly and immediately re-squatting.' },
    { id: 'ex-boxjmp',  name: 'Box Jumps',          category: 'HIIT',        caloriesPerMin: 13.0, description: 'Jump onto a sturdy platform to build explosive leg power. Step down carefully between reps.' },
    { id: 'ex-sprint',  name: 'Sprint Intervals',   category: 'HIIT',        caloriesPerMin: 16.0, description: 'Alternate between maximum effort sprints and walking recovery. Massively effective for fat loss.' },
    // FLEXIBILITY
    { id: 'ex-ddog',    name: 'Downward Dog',       category: 'FLEXIBILITY', caloriesPerMin: 3.5,  description: 'Foundational yoga pose stretching hamstrings, calves, and shoulders while strengthening arms and legs.' },
    { id: 'ex-child',   name: "Child's Pose",       category: 'FLEXIBILITY', caloriesPerMin: 2.0,  description: 'Restorative yoga pose that gently stretches the hips, thighs, and lower back. Perfect for recovery.' },
    { id: 'ex-hipfx',   name: 'Hip Flexor Stretch', category: 'FLEXIBILITY', caloriesPerMin: 2.5,  description: 'Kneeling lunge stretch opening up hip flexors, which get tight from prolonged sitting.' },
  ];

  for (const ex of exerciseData) {
    await prisma.exercise.upsert({
      where:  { id: ex.id },
      update: { name: ex.name, description: ex.description, category: ex.category, caloriesPerMin: ex.caloriesPerMin },
      create: { ...ex, isActive: true },
    });
  }
  console.log(`   ✓ ${exerciseData.length} exercises\n`);

  // ────────────────────────────────────────────────────────────────────────────
  // 2. ACHIEVEMENTS  (matches Achievement model exactly)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('→ Seeding achievements...');

  const achievementData = [
    { name: 'First Workout',     description: 'Complete your very first workout',              icon: '🎯', category: 'MILESTONE', requirement: { type: 'total_workouts', value: 1 },    points: 10 },
    { name: 'Week Warrior',      description: 'Complete 7 consecutive days of workouts',       icon: '🔥', category: 'STREAK',    requirement: { type: 'streak_days',    value: 7 },    points: 50 },
    { name: 'Century Club',      description: 'Log 100 total workouts',                        icon: '💯', category: 'MILESTONE', requirement: { type: 'total_workouts', value: 100 },  points: 200 },
    { name: 'Calorie Crusher',   description: 'Burn 10,000 total calories',                    icon: '🔥', category: 'CALORIES',  requirement: { type: 'total_calories', value: 10000 }, points: 100 },
    { name: 'Iron Will',         description: 'Maintain a 30-day workout streak',              icon: '💪', category: 'STREAK',    requirement: { type: 'streak_days',    value: 30 },   points: 250 },
    { name: 'Early Bird',        description: 'Complete 10 workouts before 8am',               icon: '🌅', category: 'HABIT',     requirement: { type: 'early_workouts', value: 10 },   points: 75 },
    { name: 'Strength Seeker',   description: 'Complete 25 strength training sessions',        icon: '🏋️', category: 'CATEGORY',  requirement: { type: 'category_workouts', category: 'STRENGTH', value: 25 }, points: 100 },
    { name: 'Cardio King',       description: 'Complete 25 cardio sessions',                   icon: '🏃', category: 'CATEGORY',  requirement: { type: 'category_workouts', category: 'CARDIO',   value: 25 }, points: 100 },
    { name: 'Core Master',       description: 'Complete 25 core workouts',                     icon: '🧘', category: 'CATEGORY',  requirement: { type: 'category_workouts', category: 'CORE',     value: 25 }, points: 100 },
    { name: 'Program Graduate',  description: 'Complete your first full training program',     icon: '🎓', category: 'PROGRAM',   requirement: { type: 'programs_completed', value: 1 },           points: 300 },
  ];

  for (const a of achievementData) {
    await prisma.achievement.upsert({
      where:  { name: a.name },
      update: { description: a.description, icon: a.icon, points: a.points },
      create: a,
    });
  }
  console.log(`   ✓ ${achievementData.length} achievements\n`);

  // ────────────────────────────────────────────────────────────────────────────
  // 3. PROGRAMS  (Program → Week → Day → DayExercise, matching schema exactly)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('→ Seeding programs...');

  // Helper: create a program with its full week/day/exercise structure
  async function seedProgram(
    id: string, title: string, description: string,
    durationWeeks: number, daysPerWeek: number,
    weekTemplates: string[][][] // weekTemplates[week][day][exerciseId]
  ) {
    const program = await prisma.program.upsert({
      where:  { id },
      update: { title, description, durationWeeks, daysPerWeek },
      create: { id, title, description, durationWeeks, daysPerWeek },
    });

    for (let wi = 0; wi < weekTemplates.length; wi++) {
      const weekId = `${id}-w${wi + 1}`;
      const week = await prisma.week.upsert({
        where:  { id: weekId },
        update: { weekNumber: wi + 1, title: `Week ${wi + 1}` },
        create: { id: weekId, weekNumber: wi + 1, title: `Week ${wi + 1}`, programId: program.id },
      });

      for (let di = 0; di < weekTemplates[wi].length; di++) {
        const dayId = `${weekId}-d${di + 1}`;
        const day = await prisma.day.upsert({
          where:  { id: dayId },
          update: { dayNumber: di + 1 },
          create: { id: dayId, dayNumber: di + 1, weekId: week.id },
        });

        for (let ei = 0; ei < weekTemplates[wi][di].length; ei++) {
          const deId = `${dayId}-ex${ei + 1}`;
          await prisma.dayExercise.upsert({
            where:  { id: deId },
            update: { orderIndex: ei + 1, exerciseId: weekTemplates[wi][di][ei] },
            create: { id: deId, orderIndex: ei + 1, dayId: day.id, exerciseId: weekTemplates[wi][di][ei] },
          });
        }
      }
    }
    return program;
  }

  // Repeat a week template for N weeks
  const repeat = (template: string[][], n: number) => Array.from({ length: n }, () => template);

  await seedProgram(
    'prog-beginner', 'Beginner Foundation',
    'Perfect for beginners. Master fundamental movements, build confidence, and establish a sustainable fitness habit over 4 weeks.',
    4, 3,
    repeat([
      ['ex-pushup', 'ex-dips',   'ex-plank'],   // Day 1 — Upper
      ['ex-squat',  'ex-lunge',  'ex-glute'],   // Day 2 — Lower
      ['ex-crunch', 'ex-jjack',  'ex-plank'],   // Day 3 — Core & Cardio
    ], 4)
  );

  await seedProgram(
    'prog-hiit', 'Fat Burn HIIT',
    'High-intensity interval training to maximise calorie burn and boost your metabolism. For intermediate athletes ready to push their limits.',
    6, 4,
    repeat([
      ['ex-burpee', 'ex-sqjmp',  'ex-mclimb'],  // Day 1
      ['ex-hknees', 'ex-bkicks', 'ex-jjack'],   // Day 2
      ['ex-sprint', 'ex-boxjmp', 'ex-burpee'],  // Day 3
      ['ex-sqjmp',  'ex-mclimb', 'ex-plank'],   // Day 4
    ], 6)
  );

  await seedProgram(
    'prog-core', 'Core Power',
    'Focused 4-week core training to build a strong, stable midsection. Suitable for all fitness levels.',
    4, 3,
    repeat([
      ['ex-plank',  'ex-crunch', 'ex-lraise'],  // Day 1
      ['ex-mclimb', 'ex-rtwist', 'ex-plank'],   // Day 2
      ['ex-lraise', 'ex-crunch', 'ex-rtwist'],  // Day 3
    ], 4)
  );

  await seedProgram(
    'prog-strength', 'Full Body Strength',
    'Comprehensive 8-week bodyweight strength program with progressive overload built in. For intermediate athletes.',
    8, 5,
    repeat([
      ['ex-pushup', 'ex-pike',   'ex-dips'],    // Day 1 — Upper Push
      ['ex-squat',  'ex-lunge',  'ex-glute'],   // Day 2 — Lower
      ['ex-plank',  'ex-crunch', 'ex-mclimb'],  // Day 3 — Core
      ['ex-burpee', 'ex-jjack',  'ex-hknees'],  // Day 4 — Cardio
      ['ex-pushup', 'ex-squat',  'ex-plank'],   // Day 5 — Full Body
    ], 8)
  );

  await seedProgram(
    'prog-flex', 'Mobility & Flexibility',
    'Improve range of motion, reduce injury risk, and recover faster. Perfect for athletes with tight hips and hamstrings.',
    3, 4,
    repeat([
      ['ex-ddog',   'ex-hipfx',  'ex-child'],   // Day 1
      ['ex-hipfx',  'ex-ddog',   'ex-child'],   // Day 2
      ['ex-child',  'ex-ddog',   'ex-hipfx'],   // Day 3
      ['ex-ddog',   'ex-child',  'ex-hipfx'],   // Day 4
    ], 3)
  );

  console.log('   ✓ 5 programs (Beginner Foundation, Fat Burn HIIT, Core Power, Full Body Strength, Mobility & Flexibility)\n');

  console.log('✅ Seeding complete!');
  console.log('   21 exercises · 10 achievements · 5 programs');
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
