/**
 * FLOWFIT — Seed + Admin Routes  (patched for schema v3)
 *
 * All TypeScript errors from the previous version of this file were caused
 * by MpesaTransaction queries written against an older schema.
 *
 * Schema v3 changes that broke the old code
 * ──────────────────────────────────────────
 *  OLD field          →  NEW field / fix
 *  ─────────────────────────────────────────────────────────────────────────
 *  createdAt          →  initiatedAt  (MpesaTransaction has no createdAt)
 *  include: { plan }  →  removed      (MpesaTransaction has no plan relation)
 *  include: { user }  →  include: { user: { select: {name,email,mpesaPhone} } }
 *  tx.createdAt       →  tx.initiatedAt
 *  tx.plan            →  tx.subscription?.plan (join through subscription)
 *  tx.interval        →  tx.subscription?.interval
 *  tx.planId          →  tx.subscription?.planId
 *  status: 'COMPLETED' → status: 'SUCCESS'  (MpesaTransactionStatus enum)
 *
 * These fixes address every error in the build log:
 *   TS2353 — 'createdAt' / 'plan' not in MpesaTransactionOrderByWithRelationInput
 *   TS2339 — 'user' / 'plan' / 'interval' / 'createdAt' / 'planId' not on result type
 *   TS2322 — '"COMPLETED"' not assignable to MpesaTransactionStatus
 */

import { Router, Request, Response } from 'express';
import { PrismaClient }              from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ── Security helper ──────────────────────────────────────────────────────────
function requireSeedSecret(req: Request, res: Response): boolean {
  const secret   = (req.query.secret as string) || req.headers['x-seed-secret'];
  const expected = process.env.SEED_SECRET;

  if (!expected) {
    res.status(500).json({
      success: false,
      error:   'SEED_SECRET env var not set. Add it in Vercel dashboard.',
    });
    return false;
  }

  if (!secret || secret !== expected) {
    res.status(401).json({
      success: false,
      error:   'Invalid or missing secret.',
    });
    return false;
  }

  return true;
}

// ── GET /seed — seed exercises, achievements, programs ───────────────────────
router.get('/', async (req: Request, res: Response) => {
  if (!requireSeedSecret(req, res)) return;

  try {
    const log: string[] = [];

    // ── Exercises ──────────────────────────────────────────────────────────────
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
      { id:'ex-mclimb', name:'Mountain Climbers',  category:'CORE',        caloriesPerMin:11.0, description:'Dynamic core and cardio — drive knees toward chest from plank.' },
      { id:'ex-crunch', name:'Crunches',           category:'CORE',        caloriesPerMin:5.5,  description:'Classic abdominal exercise targeting the rectus abdominis.' },
      { id:'ex-rtwist', name:'Russian Twists',     category:'CORE',        caloriesPerMin:6.5,  description:'Rotational core exercise targeting obliques.' },
      { id:'ex-lraise', name:'Leg Raises',         category:'CORE',        caloriesPerMin:5.0,  description:'Lower ab exercise — raise straight legs to 90° and slowly lower.' },
      { id:'ex-sqjmp',  name:'Jump Squats',        category:'HIIT',        caloriesPerMin:14.0, description:'Explosive plyometric squat — explode upward and land softly.' },
      { id:'ex-boxjmp', name:'Box Jumps',          category:'HIIT',        caloriesPerMin:13.0, description:'Jump onto a sturdy platform to build explosive leg power.' },
      { id:'ex-sprint', name:'Sprint Intervals',   category:'HIIT',        caloriesPerMin:16.0, description:'Alternate max effort sprints with walking recovery.' },
      { id:'ex-ddog',   name:'Downward Dog',       category:'FLEXIBILITY', caloriesPerMin:3.5,  description:'Foundational yoga pose stretching hamstrings, calves, and shoulders.' },
      { id:'ex-child',  name:"Child's Pose",       category:'FLEXIBILITY', caloriesPerMin:2.0,  description:'Restorative pose gently stretching hips, thighs, and lower back.' },
      { id:'ex-hipfx',  name:'Hip Flexor Stretch', category:'FLEXIBILITY', caloriesPerMin:2.5,  description:'Kneeling lunge stretch opening up hip flexors tight from sitting.' },
    ];

    let exCount = 0;
    for (const ex of exerciseData) {
      await prisma.exercise.upsert({
        where:  { id: ex.id },
        update: { name: ex.name, description: ex.description, category: ex.category, caloriesPerMin: ex.caloriesPerMin },
        create: { ...ex, isActive: true },
      });
      exCount++;
    }
    log.push(`${exCount} exercises`);

    // ── Achievements ───────────────────────────────────────────────────────────
    const achievements = [
      { name:'First Workout',    description:'Complete your very first workout',         icon:'target',   category:'MILESTONE', requirement:{ type:'total_workouts', value:1 },          points:10 },
      { name:'Week Warrior',     description:'Complete 7 consecutive days of workouts',  icon:'fire',     category:'STREAK',    requirement:{ type:'streak_days',    value:7 },          points:50 },
      { name:'Century Club',     description:'Log 100 total workouts',                   icon:'trophy',   category:'MILESTONE', requirement:{ type:'total_workouts', value:100 },        points:200 },
      { name:'Calorie Crusher',  description:'Burn 10,000 total calories',               icon:'flame',    category:'CALORIES',  requirement:{ type:'total_calories', value:10000 },      points:100 },
      { name:'Iron Will',        description:'Maintain a 30-day workout streak',         icon:'diamond',  category:'STREAK',    requirement:{ type:'streak_days',    value:30 },         points:250 },
      { name:'Early Bird',       description:'Complete 10 workouts before 8am',          icon:'sun',      category:'HABIT',     requirement:{ type:'early_workouts', value:10 },         points:75 },
      { name:'Strength Seeker',  description:'Complete 25 strength training sessions',   icon:'dumbbell', category:'CATEGORY',  requirement:{ type:'category_workouts', category:'STRENGTH', value:25 }, points:100 },
      { name:'Cardio King',      description:'Complete 25 cardio sessions',              icon:'heart',    category:'CATEGORY',  requirement:{ type:'category_workouts', category:'CARDIO',   value:25 }, points:100 },
      { name:'Core Master',      description:'Complete 25 core workouts',                icon:'shield',   category:'CATEGORY',  requirement:{ type:'category_workouts', category:'CORE',     value:25 }, points:100 },
      { name:'Program Graduate', description:'Complete your first full training program',icon:'star',     category:'PROGRAM',   requirement:{ type:'programs_completed', value:1 },          points:300 },
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
    log.push(`${achCount} achievements`);

    // ── Programs ───────────────────────────────────────────────────────────────
    type ProgramDef = {
      id:            string;
      title:         string;
      description:   string;
      durationWeeks: number;
      daysPerWeek:   number;
      weeks:         string[][][];
    };

    const programs: ProgramDef[] = [
      {
        id: 'prog-beginner', title: 'Beginner Foundation', durationWeeks: 4, daysPerWeek: 3,
        description: 'Perfect for beginners. Master fundamental movements over 4 weeks.',
        weeks: Array(4).fill([
          ['ex-pushup', 'ex-dips',   'ex-plank'],
          ['ex-squat',  'ex-lunge',  'ex-glute'],
          ['ex-crunch', 'ex-jjack',  'ex-plank'],
        ]),
      },
      {
        id: 'prog-hiit', title: 'Fat Burn HIIT', durationWeeks: 6, daysPerWeek: 4,
        description: 'High-intensity interval training to maximise calorie burn.',
        weeks: Array(6).fill([
          ['ex-burpee', 'ex-sqjmp',  'ex-mclimb'],
          ['ex-hknees', 'ex-bkicks', 'ex-jjack'],
          ['ex-sprint', 'ex-boxjmp', 'ex-burpee'],
          ['ex-sqjmp',  'ex-mclimb', 'ex-plank'],
        ]),
      },
      {
        id: 'prog-core', title: 'Core Power', durationWeeks: 4, daysPerWeek: 3,
        description: 'Focused 4-week core training to build a strong, stable midsection.',
        weeks: Array(4).fill([
          ['ex-plank',  'ex-crunch', 'ex-lraise'],
          ['ex-mclimb', 'ex-rtwist', 'ex-plank'],
          ['ex-lraise', 'ex-crunch', 'ex-rtwist'],
        ]),
      },
      {
        id: 'prog-strength', title: 'Full Body Strength', durationWeeks: 8, daysPerWeek: 5,
        description: 'Comprehensive 8-week bodyweight strength program.',
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
        description: 'Improve range of motion and reduce injury risk.',
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
    log.push(`${progCount} programs`);

    return res.json({
      success: true,
      message: 'Database seeded successfully.',
      seeded:  log,
      next:    'Delete this route from your codebase and redeploy.',
    });

  } catch (error: any) {
    console.error('Seed error:', error);
    return res.status(500).json({
      success: false,
      error:   error.message || 'Seed failed',
    });
  } finally {
    await prisma.$disconnect();
  }
});

// ── GET /seed/admin/mpesa — M-Pesa transaction admin report ──────────────────
//
// SCHEMA v3 FIXES applied here (these were the TypeScript errors in the build):
//
//  1. orderBy: { initiatedAt: 'desc' }   — was: { createdAt: 'desc' }
//     MpesaTransaction has no createdAt field; the timestamp is initiatedAt.
//
//  2. include: { subscription: { include: { plan: true } } }
//     — was: include: { plan: true }
//     MpesaTransaction has NO direct plan relation. Plan is reached through
//     subscription → plan. This requires two levels of include.
//
//  3. Property access: tx.initiatedAt     — was: tx.createdAt
//     Property access: tx.subscription?.plan    — was: tx.plan
//     Property access: tx.subscription?.interval — was: tx.interval
//     Property access: tx.subscription?.planId   — was: tx.planId
//     The transaction model does not carry plan/interval/planId directly.
//
//  4. status: 'SUCCESS'  — was: status: 'COMPLETED'
//     MpesaTransactionStatus enum values: PENDING | SUCCESS | FAILED |
//     CANCELLED | TIMEOUT.  'COMPLETED' does not exist in the enum.
//
router.get('/admin/mpesa', async (req: Request, res: Response) => {
  if (!requireSeedSecret(req, res)) return;

  try {
    // FIX 1 + FIX 2: correct orderBy field and correct include chain
    const transactions = await prisma.mpesaTransaction.findMany({
      orderBy: { initiatedAt: 'desc' },    // FIX 1: was createdAt
      take:    100,
      include: {
        user: {
          select: {
            name:       true,
            email:      true,
            mpesaPhone: true,
          },
        },
        subscription: {                    // FIX 2: was include: { plan: true }
          include: {
            plan: {
              select: {
                slug: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // FIX 3: use initiatedAt, access plan through subscription
    const rows = transactions.map(tx => ({
      id:                tx.id,
      userId:            tx.userId,
      userName:          tx.user?.name  ?? null,    // FIX 3a: .user now included
      userEmail:         tx.user?.email ?? null,
      phone:             tx.phoneNumber            ?? null,
      planSlug:          tx.subscription?.plan?.slug ?? null,  // FIX 3b: through subscription
      planName:          tx.subscription?.plan?.name ?? null,
      interval:          tx.subscription?.interval  ?? null,   // FIX 3c: from subscription
      amountKes:         tx.amountKes,
      status:            tx.status,
      resultCode:        tx.resultCode,
      resultDesc:        tx.resultDesc,
      receiptNumber:     tx.mpesaReceiptNumber,
      initiatedAt:       tx.initiatedAt,           // FIX 3d: was tx.createdAt
      completedAt:       tx.completedAt,
      isRenewal:         tx.isRenewal,
      attemptNumber:     tx.attemptNumber,
    }));

    // Summary stats
    const summary = {
      total:    rows.length,
      pending:  rows.filter(r => r.status === 'PENDING').length,
      success:  rows.filter(r => r.status === 'SUCCESS').length,   // FIX 4: not COMPLETED
      failed:   rows.filter(r => r.status === 'FAILED').length,
      cancelled:rows.filter(r => r.status === 'CANCELLED').length,
      timeout:  rows.filter(r => r.status === 'TIMEOUT').length,
    };

    res.json({ success: true, summary, transactions: rows });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await prisma.$disconnect();
  }
});

// ── POST /seed/admin/mpesa/fix-pending — resolve stuck PENDING transactions ──
//
// Marks PENDING transactions that are past their timeoutAt as TIMEOUT.
// Safe to run at any time; idempotent.
//
router.post('/admin/mpesa/fix-pending', async (req: Request, res: Response) => {
  if (!requireSeedSecret(req, res)) return;

  try {
    const now = new Date();

    // FIX 4: use 'TIMEOUT' — not 'COMPLETED', not 'FAILED'
    const result = await prisma.mpesaTransaction.updateMany({
      where: {
        status:    'PENDING',
        timeoutAt: { lt: now },
      },
      data: {
        status:      'TIMEOUT',             // FIX 4: valid MpesaTransactionStatus value
        resultDesc:  'Auto-resolved: STK push timed out with no callback received.',
        completedAt: now,
      },
    });

    res.json({
      success:  true,
      resolved: result.count,
      message:  `${result.count} stuck PENDING transaction(s) marked as TIMEOUT.`,
    });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await prisma.$disconnect();
  }
});

export default router;
