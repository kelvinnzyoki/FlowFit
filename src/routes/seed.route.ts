/**
 * ONE-TIME SEED ROUTE
 * ───────────────────
 * Add to your routes/index.ts, deploy to Vercel, visit the URL once, then DELETE this file.
 *
 * USAGE:
 *   1. Add to routes/index.ts:
 *        import seedRoute from './seed.route.js';
 *        router.use('/seed', seedRoute);
 *
 *   2. Set SEED_SECRET in your Vercel environment variables to any secret string
 *      (e.g. "myapp-seed-2024-abc123")
 *
 *   3. Deploy: git add . && git commit -m "add seed route" && git push
 *
 *   4. Open on your phone:
 *      https://fit.cctamcc.site/api/v1/seed?secret=YOUR_SEED_SECRET
 *
 *   5. Wait ~30 seconds. You'll see JSON confirming success.
 *
 *   6. DELETE this file + remove the import from routes/index.ts + redeploy.
 *      Never leave a seed route live in production.
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req: Request, res: Response) => {
  // ── Security: require secret query param so random people can't trigger it ─
  const secret = req.query.secret as string;
  const expected = process.env.SEED_SECRET;

  if (!expected) {
    return res.status(500).json({
      success: false,
      error: 'SEED_SECRET environment variable not set. Add it in Vercel dashboard.',
    });
  }

  if (!secret || secret !== expected) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing ?secret= parameter.',
    });
  }

  try {
    const log: string[] = [];

    // ──────────────────────────────────────────────────────────────────────────
    // EXERCISES
    // ──────────────────────────────────────────────────────────────────────────
    const exerciseData = [
      { id:'ex-pushup', name:'Push-ups',           category:'STRENGTH',    caloriesPerMin:8.0,  description:'Classic upper body exercise targeting chest, shoulders, and triceps.' },
      { id:'ex-squat',  name:'Squats',             category:'STRENGTH',    caloriesPerMin:9.0,  description:'Fundamental lower body movement for building leg strength and power.' },
      { id:'ex-lunge',  name:'Lunges',             category:'STRENGTH',    caloriesPerMin:7.5,  description:'Unilateral leg exercise improving balance and lower body strength.' },
      { id:'ex-dips',   name:'Tricep Dips',        category:'STRENGTH',    caloriesPerMin:7.0,  description:'Bodyweight exercise targeting triceps, chest, and anterior deltoids.' },
      { id:'ex-glute',  name:'Glute Bridges',      category:'STRENGTH',    caloriesPerMin:6.0,  description:'Hip extension exercise activating glutes and hamstrings.' },
      { id:'ex-pike',   name:'Pike Push-ups',      category:'STRENGTH',    caloriesPerMin:8.5,  description:'Advanced shoulder exercise. Form an inverted V and lower head to floor.' },
      { id:'ex-burpee', name:'Burpees',            category:'CARDIO',      caloriesPerMin:12.0, description:'High-intensity full-body exercise combining squat, push-up, and jump.' },
      { id:'ex-jjack',  name:'Jumping Jacks',      category:'CARDIO',      caloriesPerMin:8.0,  description:'Classic full-body cardio warm-up elevating heart rate and coordination.' },
      { id:'ex-hknees', name:'High Knees',         category:'CARDIO',      caloriesPerMin:10.0, description:'Running in place driving knees up to hip level. Great for endurance.' },
      { id:'ex-bkicks', name:'Butt Kicks',         category:'CARDIO',      caloriesPerMin:9.0,  description:'Jogging in place kicking heels toward glutes. Improves hamstring flexibility.' },
      { id:'ex-plank',  name:'Plank',              category:'CORE',        caloriesPerMin:5.0,  description:'Isometric core exercise building full-body endurance and stability.' },
      { id:'ex-mclimb', name:'Mountain Climbers',  category:'CORE',        caloriesPerMin:11.0, description:'Dynamic core and cardio — drive knees toward chest from plank position.' },
      { id:'ex-crunch', name:'Crunches',           category:'CORE',        caloriesPerMin:5.5,  description:'Classic abdominal exercise targeting the rectus abdominis.' },
      { id:'ex-rtwist', name:'Russian Twists',     category:'CORE',        caloriesPerMin:6.5,  description:'Rotational core exercise targeting obliques.' },
      { id:'ex-lraise', name:'Leg Raises',         category:'CORE',        caloriesPerMin:5.0,  description:'Lower ab exercise — raise straight legs to 90° and slowly lower.' },
      { id:'ex-sqjmp',  name:'Jump Squats',        category:'HIIT',        caloriesPerMin:14.0, description:'Explosive plyometric squat — explode upward and land softly.' },
      { id:'ex-boxjmp', name:'Box Jumps',          category:'HIIT',        caloriesPerMin:13.0, description:'Jump onto a sturdy platform to build explosive leg power.' },
      { id:'ex-sprint', name:'Sprint Intervals',   category:'HIIT',        caloriesPerMin:16.0, description:'Alternate max effort sprints with walking recovery. Best for fat loss.' },
      { id:'ex-ddog',   name:'Downward Dog',       category:'FLEXIBILITY', caloriesPerMin:3.5,  description:'Foundational yoga pose stretching hamstrings, calves, and shoulders.' },
      { id:'ex-child',  name:"Child's Pose",       category:'FLEXIBILITY', caloriesPerMin:2.0,  description:'Restorative pose gently stretching hips, thighs, and lower back.' },
      { id:'ex-hipfx',  name:'Hip Flexor Stretch', category:'FLEXIBILITY', caloriesPerMin:2.5,  description:'Kneeling lunge stretch opening up hip flexors tight from sitting.' },
    ];

    let exCount = 0;
    for (const ex of exerciseData) {
      await prisma.exercise.upsert({
        where: { id: ex.id },
        update: { name: ex.name, description: ex.description, category: ex.category, caloriesPerMin: ex.caloriesPerMin },
        create: { ...ex, isActive: true },
      });
      exCount++;
    }
    log.push(`✓ ${exCount} exercises`);

    // ──────────────────────────────────────────────────────────────────────────
    // ACHIEVEMENTS
    // ──────────────────────────────────────────────────────────────────────────
    const achievements = [
      { name:'First Workout',    description:'Complete your very first workout',           icon:'🎯', category:'MILESTONE', requirement:{ type:'total_workouts', value:1 },    points:10 },
      { name:'Week Warrior',     description:'Complete 7 consecutive days of workouts',    icon:'🔥', category:'STREAK',    requirement:{ type:'streak_days',    value:7 },    points:50 },
      { name:'Century Club',     description:'Log 100 total workouts',                     icon:'💯', category:'MILESTONE', requirement:{ type:'total_workouts', value:100 },  points:200 },
      { name:'Calorie Crusher',  description:'Burn 10,000 total calories',                 icon:'🔥', category:'CALORIES',  requirement:{ type:'total_calories', value:10000 }, points:100 },
      { name:'Iron Will',        description:'Maintain a 30-day workout streak',           icon:'💪', category:'STREAK',    requirement:{ type:'streak_days',    value:30 },   points:250 },
      { name:'Early Bird',       description:'Complete 10 workouts before 8am',            icon:'🌅', category:'HABIT',     requirement:{ type:'early_workouts', value:10 },   points:75 },
      { name:'Strength Seeker',  description:'Complete 25 strength training sessions',     icon:'🏋️', category:'CATEGORY',  requirement:{ type:'category_workouts', category:'STRENGTH', value:25 }, points:100 },
      { name:'Cardio King',      description:'Complete 25 cardio sessions',                icon:'🏃', category:'CATEGORY',  requirement:{ type:'category_workouts', category:'CARDIO',   value:25 }, points:100 },
      { name:'Core Master',      description:'Complete 25 core workouts',                  icon:'🧘', category:'CATEGORY',  requirement:{ type:'category_workouts', category:'CORE',     value:25 }, points:100 },
      { name:'Program Graduate', description:'Complete your first full training program',  icon:'🎓', category:'PROGRAM',   requirement:{ type:'programs_completed', value:1 },           points:300 },
    ];

    let achCount = 0;
    for (const a of achievements) {
      await prisma.achievement.upsert({
        where:  { name: a.name },
        update: { description: a.description, icon: a.icon, points: a.points },
        create: a,
      });
      achCount++;
    }
    log.push(`✓ ${achCount} achievements`);

    // ──────────────────────────────────────────────────────────────────────────
    // PROGRAMS (with weeks, days, exercises)
    // ──────────────────────────────────────────────────────────────────────────
    type ProgramDef = {
      id: string; title: string; description: string;
      durationWeeks: number; daysPerWeek: number;
      weeks: string[][][]; // weeks[weekIdx][dayIdx] = exerciseId[]
    };

    const programs: ProgramDef[] = [
      {
        id: 'prog-beginner', title: 'Beginner Foundation', durationWeeks: 4, daysPerWeek: 3,
        description: 'Perfect for beginners. Master fundamental movements, build confidence, and establish a sustainable fitness habit over 4 weeks.',
        weeks: Array(4).fill([
          ['ex-pushup', 'ex-dips',   'ex-plank'],
          ['ex-squat',  'ex-lunge',  'ex-glute'],
          ['ex-crunch', 'ex-jjack',  'ex-plank'],
        ]),
      },
      {
        id: 'prog-hiit', title: 'Fat Burn HIIT', durationWeeks: 6, daysPerWeek: 4,
        description: 'High-intensity interval training to maximise calorie burn and boost your metabolism. For intermediate athletes ready to push their limits.',
        weeks: Array(6).fill([
          ['ex-burpee', 'ex-sqjmp',  'ex-mclimb'],
          ['ex-hknees', 'ex-bkicks', 'ex-jjack'],
          ['ex-sprint', 'ex-boxjmp', 'ex-burpee'],
          ['ex-sqjmp',  'ex-mclimb', 'ex-plank'],
        ]),
      },
      {
        id: 'prog-core', title: 'Core Power', durationWeeks: 4, daysPerWeek: 3,
        description: 'Focused 4-week core training to build a strong, stable midsection. Suitable for all fitness levels.',
        weeks: Array(4).fill([
          ['ex-plank',  'ex-crunch', 'ex-lraise'],
          ['ex-mclimb', 'ex-rtwist', 'ex-plank'],
          ['ex-lraise', 'ex-crunch', 'ex-rtwist'],
        ]),
      },
      {
        id: 'prog-strength', title: 'Full Body Strength', durationWeeks: 8, daysPerWeek: 5,
        description: 'Comprehensive 8-week bodyweight strength program with progressive overload. For intermediate athletes.',
        weeks: Array(8).fill([
          ['ex-pushup', 'ex-pike',   'ex-dips'],
          ['ex-squat',  'ex-lunge',  'ex-glute'],
          ['ex-plank',  'ex-crunch', 'ex-mclimb'],
          ['ex-burpee', 'ex-jjack',  'ex-hknees'],
          ['ex-pushup', 'ex-squat',  'ex-plank'],
        ]),
      },
      {
        id: 'prog-flex', title: 'Mobility & Flexibility', durationWeeks: 3, daysPerWeek: 4,
        description: 'Improve range of motion, reduce injury risk, and recover faster. Perfect for athletes with tight hips and hamstrings.',
        weeks: Array(3).fill([
          ['ex-ddog',  'ex-hipfx', 'ex-child'],
          ['ex-hipfx', 'ex-ddog',  'ex-child'],
          ['ex-child', 'ex-ddog',  'ex-hipfx'],
          ['ex-ddog',  'ex-child', 'ex-hipfx'],
        ]),
      },
    ];

    let progCount = 0;
    for (const p of programs) {
      await prisma.program.upsert({
        where:  { id: p.id },
        update: { title: p.title, description: p.description, durationWeeks: p.durationWeeks, daysPerWeek: p.daysPerWeek },
        create: { id: p.id, title: p.title, description: p.description, durationWeeks: p.durationWeeks, daysPerWeek: p.daysPerWeek },
      });

      for (let wi = 0; wi < p.weeks.length; wi++) {
        const weekId = `${p.id}-w${wi + 1}`;
        await prisma.week.upsert({
          where:  { id: weekId },
          update: { weekNumber: wi + 1 },
          create: { id: weekId, weekNumber: wi + 1, title: `Week ${wi + 1}`, programId: p.id },
        });

        for (let di = 0; di < p.weeks[wi].length; di++) {
          const dayId = `${weekId}-d${di + 1}`;
          await prisma.day.upsert({
            where:  { id: dayId },
            update: { dayNumber: di + 1 },
            create: { id: dayId, dayNumber: di + 1, weekId },
          });

          for (let ei = 0; ei < p.weeks[wi][di].length; ei++) {
            const deId = `${dayId}-ex${ei + 1}`;
            await prisma.dayExercise.upsert({
              where:  { id: deId },
              update: { orderIndex: ei + 1, exerciseId: p.weeks[wi][di][ei] },
              create: { id: deId, orderIndex: ei + 1, dayId, exerciseId: p.weeks[wi][di][ei] },
            });
          }
        }
      }
      progCount++;
    }
    log.push(`✓ ${progCount} programs`);

    // ── Done ──────────────────────────────────────────────────────────────────
    return res.json({
      success: true,
      message: '🌱 Database seeded successfully!',
      seeded: log,
      next: 'Delete this route from your codebase and redeploy.',
    });

  } catch (error: any) {
    console.error('Seed error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Seed failed',
      hint: 'Check your Vercel function logs for the full stack trace.',
    });
  } finally {
    await prisma.$disconnect();
  }
});

export default router;
