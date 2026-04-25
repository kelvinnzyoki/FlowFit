// aiCoach.service.ts — V12
// Full real data connected: WorkoutLog, ProgramEnrollment, UserMetrics,
// Achievements, Streak, Subscription/Plan, full Profile.
// Groq llama-3.3-70b-versatile + local n-gram embeddings.

import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const GROQ_API_KEY     = process.env.GROQ_API_KEY ?? '';
const GROQ_CHAT_URL    = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL       = 'llama-3.3-70b-versatile';
const FETCH_TIMEOUT_MS = 25_000;
const MAX_RETRIES      = 3;
const MAX_EMBEDDINGS   = 200;
const EMBED_DIMS       = 512;

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type ToolName =
  | 'generate_workout'
  | 'next_workout'
  | 'program_status'
  | 'weekly_program'
  | 'workout_history'
  | 'adaptive_adjustment'
  | 'body_metrics'
  | 'achievements'
  | 'streak_info'
  | 'recovery_plan'
  | 'log_workout'
  | 'nutrition_plan'
  | 'macro_calculator'
  | 'log_meal'
  | 'quick_nutrition'
  | 'nutrition_summary';

interface ConversationMemory {
  adherenceScore?: number;
  fatigueScore?:   number;
  lastTool?:       string;
  messageCount?:   number;
}

interface UserContext {
  name:           string;
  fitnessGoal:    string;
  fitnessLevel:   string;
  weight?:        number;
  targetWeight?:  number;
  height?:        number;
  gender?:        string;
  ageYears?:      number;
  planName:       string;
  hasCoaching:    boolean;
  hasNutrition:   boolean;
  currentStreak:  number;
  longestStreak:  number;
  lastWorkoutDate: string | null;
  program?: {
    title:          string;
    durationWeeks:  number;
    daysPerWeek:    number;
    currentWeek:    number;
    currentDay:     number;
    completedDays:  number;
    totalDays:      number;
    pctComplete:    number;
    nextExercises:  string[];
    
  };
  recentLogs: {
    date:      string;
    exercise:  string;
    category:  string;
    sets?:     number;
    reps?:     number;
    duration:  number;
    calories?: number;
    skipped:   boolean;
  }[];
  volumeThisWeek:  number;
  volumeLastWeek:  number;
  volumeChangePct: number;
  latestMetrics?: {
    weight?:           number;
    bodyFat?:          number;
    muscleMass?:       number;
    bmi?:              number;
    restingHeartRate?: number;
    date:              string;
  };
  weightChange?:        number;
  totalAchievements:    number;
  totalPoints:          number;
  recentAchievement?:   string;
  nextAchievementHint?: string;
  fatigueScore?:        number;
  dailyCalorieTarget?:  number;
  dailyProteinTarget?:  number;
  dailyCarbTarget?:     number;
  dailyFatTarget?:      number;
  todayNutrition?: {
    calories:  number;
    protein:   number;
    carbs:     number;
    fat:       number;
    meals:     number;
  };
  nutritionAdherence7d?: number; // % of days this week user logged meals
}

interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const LLMResponseSchema = z.object({
  intent:   z.string(),
  tool: z.object({
    name: z.enum([
      'generate_workout', 'next_workout', 'program_status',
      'weekly_program', 'workout_history', 'adaptive_adjustment',
      'body_metrics', 'achievements', 'streak_info',
      'recovery_plan', 'log_workout',
      'nutrition_plan', 'macro_calculator', 'log_meal', 'nutrition_summary', 'quick_nutrition',
    ]),
    args: z.any().optional(),
  }).optional(),
  response: z.string().min(1),
}).transform(data => {
  // Strip tool if name is missing (LLM returned "tool": {} or similar)
  if (data.tool && !data.tool.name) {
    const { tool: _dropped, ...rest } = data;
    return rest as typeof data;
  }
  return data;
});

type LLMStructured = z.infer<typeof LLMResponseSchema>;

export interface CoachResponse {
  success: boolean;
  reply:   string;
  data?:   any;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, options: RequestInit, attempt = 1): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2 ** attempt * 600));
      return fetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err: any) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2 ** attempt * 600));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-KE', { weekday: 'short', month: 'short', day: 'numeric' });
}

function daysAgo(n: number): Date {
  const d = new Date(); d.setDate(d.getDate() - n); return d;
}

function weeksAgo(n: number): Date {
  const d = new Date(); d.setDate(d.getDate() - n * 7); return d;
}

// ─────────────────────────────────────────────────────────────
// SERVICE CLASS
// ─────────────────────────────────────────────────────────────

class AICoachService {

  // PUBLIC ENTRY POINT
  async getResponse(
    userId:  string,
    message: string,
    _ctx?:   { userId: string; currentExercise?: string },
  ): Promise<CoachResponse> {
    try {
      const [memory, ctx] = await Promise.all([
        this.loadMemory(userId),
        this.buildUserContext(userId),
      ]);

      memory.messageCount = (memory.messageCount ?? 0) + 1;

      const embedding = this.generateEmbedding(message);
      await this.storeEmbedding(userId, message, embedding);
      const similar = await this.semanticSearch(userId, embedding);

      const llm = await this.callLLM(message, ctx, memory, similar);
      const result = await this.execute(llm, userId, ctx, memory);

      this.updateBehavior(memory, message);
      memory.lastTool = llm.tool?.name;
      await this.saveMemory(userId, memory);

      return result;
    } catch (err: any) {
      console.error('[AICoach] getResponse error:', err);
      return { success: false, reply: 'Your coach hit a snag. Please try again in a moment.' };
    }
  }

  // BUILD RICH USER CONTEXT — all queries in parallel
  private async buildUserContext(userId: string): Promise<UserContext> {

    const today     = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const [
      profile, subscription, enrollment,
      recentLogs, thisWeekLogs, lastWeekLogs,
      metrics, oldMetric, achievements, streak,
      todayMeals, weekMeals,
    ] = await Promise.all([
      prisma.profile.findUnique({
        where: { userId },
        select: {
          firstName: true, lastName: true,
          fitnessGoal: true, fitnessLevel: true,
          weight: true, targetWeight: true,
          height: true, gender: true, dateOfBirth: true,
        },
      }),

      prisma.subscription.findFirst({
        where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
        include: { plan: { select: { name: true, hasPersonalCoaching: true, hasNutritionTracking: true } } },
        orderBy: { createdAt: 'desc' },
      }),

      prisma.programEnrollment.findFirst({
        where: { userId, isActive: true },
        include: {
          program: {
            include: {
              weeks: {
                include: {
                  days: {
                    include: {
                      exercises: {
                        include: { exercise: { select: { name: true } } },
                        orderBy: { orderIndex: 'asc' },
                      },
                    },
                    orderBy: { dayNumber: 'asc' },
                  },
                },
                orderBy: { weekNumber: 'asc' },
              },
            },
          },
        },
      }),

      prisma.workoutLog.findMany({
        where: { userId, date: { gte: daysAgo(14) } },
        include: { exercise: { select: { name: true, category: true } } },
        orderBy: { date: 'desc' },
      }),

      prisma.workoutLog.findMany({
        where: { userId, date: { gte: weeksAgo(1) }, skipped: false },
        select: { sets: true, reps: true },
      }),

      prisma.workoutLog.findMany({
        where: { userId, date: { gte: weeksAgo(2), lt: weeksAgo(1) }, skipped: false },
        select: { sets: true, reps: true },
      }),

      prisma.userMetrics.findMany({
        where: { userId }, orderBy: { date: 'desc' }, take: 3,
      }),

      prisma.userMetrics.findFirst({
        where: { userId, date: { lte: daysAgo(25) } },
        orderBy: { date: 'desc' },
        select: { weight: true },
      }),

      prisma.userAchievement.findMany({
        where: { userId },
        include: { achievement: { select: { name: true, points: true, category: true } } },
        orderBy: { unlockedAt: 'desc' },
      }),

      prisma.streak.findUnique({ where: { userId } }),

      // Nutrition — today's meals (safe: model may not exist in schema yet)
      Promise.resolve().then(() =>
        (prisma as any).nutritionLog?.findMany({
          where: { userId, date: { gte: todayStart } },
          select: { calories: true, protein: true, carbs: true, fat: true },
        }) ?? []
      ).catch(() => [] as any[]),

      // Nutrition — this week's logs for adherence calculation
      Promise.resolve().then(() =>
        (prisma as any).nutritionLog?.findMany({
          where: { userId, date: { gte: weeksAgo(1) } },
          select: { date: true },
        }) ?? []
      ).catch(() => [] as any[]),
    ]);

    // Identity
    const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || 'Athlete';
    let ageYears: number | undefined;
    if (profile?.dateOfBirth) {
      ageYears = Math.floor((Date.now() - new Date(profile.dateOfBirth).getTime()) / (365.25 * 86400000));
    }

    // Volume
    const volThis = thisWeekLogs.reduce((s, l) => s + (l.sets ?? 1) * (l.reps ?? 1), 0);
    const volLast = lastWeekLogs.reduce((s, l) => s + (l.sets ?? 1) * (l.reps ?? 1), 0);
    const volChangePct = volLast > 0 ? Math.round(((volThis - volLast) / volLast) * 100) : 0;

    // Program
    let program: UserContext['program'] | undefined;
    if (enrollment) {
      const { currentWeek, currentDay, completedDays } = enrollment;
      const totalDays = enrollment.program.durationWeeks * enrollment.program.daysPerWeek;
      const weekData = enrollment.program.weeks.find(w => w.weekNumber === currentWeek);
      const dayData  = weekData?.days.find(d => d.dayNumber === currentDay);
      program = {
        title:         enrollment.program.title,
        durationWeeks: enrollment.program.durationWeeks,
        daysPerWeek:   enrollment.program.daysPerWeek,
        currentWeek, currentDay, completedDays, totalDays,
        pctComplete:   Math.round((completedDays / Math.max(totalDays, 1)) * 100),
        nextExercises: (dayData?.exercises ?? []).map(de => de.exercise.name),
      };
    }

    // Recent logs
    const recentLogsFormatted = recentLogs.map(l => ({
      date: fmtDate(l.date), exercise: l.exercise.name, category: l.exercise.category,
      sets: l.sets ?? undefined, reps: l.reps ?? undefined,
      duration: l.duration, calories: l.caloriesBurned ?? undefined, skipped: l.skipped,
    }));

    // Metrics
    const latestMetrics = metrics[0] ? {
      weight: metrics[0].weight ?? undefined, bodyFat: metrics[0].bodyFat ?? undefined,
      muscleMass: metrics[0].muscleMass ?? undefined, bmi: metrics[0].bmi ?? undefined,
      restingHeartRate: metrics[0].restingHeartRate ?? undefined, date: fmtDate(metrics[0].date),
    } : undefined;
    const weightChange = (latestMetrics?.weight != null && oldMetric?.weight != null)
      ? Math.round((latestMetrics.weight - oldMetric.weight) * 10) / 10 : undefined;

    // Achievements
    const totalPoints = achievements.reduce((s, a) => s + a.achievement.points, 0);
    const earnedIds   = achievements.map(a => a.achievementId);
    const nextAch = await prisma.achievement.findFirst({
      where: { id: { notIn: earnedIds.length ? earnedIds : ['__none__'] } },
      orderBy: { points: 'asc' },
      select: { name: true, description: true },
    }).catch(() => null);

    // ── Nutrition ────────────────────────────────────────────────────────────
    const weight   = profile?.weight ?? 75;
    const height   = profile?.height ?? 175;
    const age      = typeof ageYears !== 'undefined' ? ageYears : 30;
    const isMale   = (profile?.gender ?? '').toLowerCase() !== 'female';
    const goal     = (profile?.fitnessGoal ?? '').toLowerCase();

    // Mifflin-St Jeor BMR → TDEE (moderate activity 1.55)
    const bmr  = isMale
      ? 10 * weight + 6.25 * height - 5 * age + 5
      : 10 * weight + 6.25 * height - 5 * age - 161;
    const tdee = Math.round(bmr * 1.55);

    // Goal-based calorie target
    const calTarget = goal.includes('loss') || goal.includes('cut')
      ? Math.round(tdee * 0.82)   // ~18% deficit
      : goal.includes('muscle') || goal.includes('gain') || goal.includes('bulk')
      ? Math.round(tdee * 1.12)   // ~12% surplus
      : tdee;                     // maintenance

    // Macro split (g): protein 2g/kg, fat 25% of cals, carbs remainder
    const proteinTarget = Math.round(weight * 2);
    const fatTarget     = Math.round((calTarget * 0.25) / 9);
    const carbTarget    = Math.round((calTarget - proteinTarget * 4 - fatTarget * 9) / 4);

    // Today's totals from logs
    const todayNutrition = todayMeals.length ? {
      calories: Math.round(todayMeals.reduce((s: number, m: any) => s + (m.calories ?? 0), 0)),
      protein:  Math.round(todayMeals.reduce((s: number, m: any) => s + (m.protein  ?? 0), 0)),
      carbs:    Math.round(todayMeals.reduce((s: number, m: any) => s + (m.carbs    ?? 0), 0)),
      fat:      Math.round(todayMeals.reduce((s: number, m: any) => s + (m.fat      ?? 0), 0)),
      meals:    todayMeals.length,
    } : undefined;

    // Nutrition adherence — unique days this week with at least one log
    const uniqueNutritionDays = new Set(
      weekMeals.map((m: any) => new Date(m.date).toDateString())
    ).size;
    const nutritionAdherence7d = Math.round((uniqueNutritionDays / 7) * 100);

    return {
      name,
      fitnessGoal:  profile?.fitnessGoal  ?? 'general fitness',
      fitnessLevel: profile?.fitnessLevel ?? 'intermediate',
      weight:       profile?.weight       ?? undefined,
      targetWeight: profile?.targetWeight ?? undefined,
      height:       profile?.height       ?? undefined,
      gender:       profile?.gender       ?? undefined,
      ageYears,
      planName:     subscription?.plan.name ?? 'Free',
      hasCoaching:  subscription?.plan.hasPersonalCoaching ?? false,
      hasNutrition: subscription?.plan.hasNutritionTracking ?? false,
      currentStreak:   streak?.currentStreak  ?? 0,
      longestStreak:   streak?.longestStreak  ?? 0,
      lastWorkoutDate: streak?.lastWorkoutDate ? fmtDate(streak.lastWorkoutDate) : null,
      program, recentLogs: recentLogsFormatted,
      volumeThisWeek: volThis, volumeLastWeek: volLast, volumeChangePct: volChangePct,
      latestMetrics, weightChange,
      totalAchievements: achievements.length, totalPoints,
      recentAchievement: achievements[0]?.achievement.name,
      nextAchievementHint: nextAch ? `${nextAch.name}: ${nextAch.description}` : undefined,
      dailyCalorieTarget:  calTarget,
      dailyProteinTarget:  proteinTarget,
      dailyCarbTarget:     carbTarget,
      dailyFatTarget:      fatTarget,
      todayNutrition,
      nutritionAdherence7d,
    };
  }

  // FORMAT CONTEXT BLOCK
  private formatContextBlock(ctx: UserContext, memory: ConversationMemory): string {
    const lines: string[] = ['=== FLOWFIT ATHLETE CONTEXT ==='];
    const age    = ctx.ageYears ? `, ${ctx.ageYears} yrs` : '';
    const gender = ctx.gender   ? `, ${ctx.gender}` : '';
    lines.push(`ATHLETE: ${ctx.name}${age}${gender}`);
    lines.push(`GOAL: ${ctx.fitnessGoal} | LEVEL: ${ctx.fitnessLevel} | PLAN: ${ctx.planName}`);
    if (ctx.weight) {
      const target = ctx.targetWeight ? ` → target ${ctx.targetWeight} kg` : '';
      const change = ctx.weightChange != null ? ` (${ctx.weightChange >= 0 ? '+' : ''}${ctx.weightChange} kg/30 days)` : '';
      lines.push(`WEIGHT: ${ctx.weight} kg${target}${change}`);
    }
    if (ctx.height) lines.push(`HEIGHT: ${ctx.height} cm`);
    if (ctx.latestMetrics?.bmi)             lines.push(`BMI: ${ctx.latestMetrics.bmi.toFixed(1)}`);
    if (ctx.latestMetrics?.bodyFat)         lines.push(`BODY FAT: ${ctx.latestMetrics.bodyFat}%`);
    if (ctx.latestMetrics?.restingHeartRate) lines.push(`RESTING HR: ${ctx.latestMetrics.restingHeartRate} bpm`);
    lines.push(`STREAK: ${ctx.currentStreak} days current | best ${ctx.longestStreak} days`);
    if (ctx.lastWorkoutDate) lines.push(`LAST WORKOUT: ${ctx.lastWorkoutDate}`);
    if (ctx.program) {
      const p = ctx.program;
      lines.push('');
      lines.push(`ACTIVE PROGRAM: "${p.title}"`);
      lines.push(`  Week ${p.currentWeek}/${p.durationWeeks}, Day ${p.currentDay} | ${p.pctComplete}% complete | ${p.completedDays} sessions done`);
      if (p.nextExercises.length) lines.push(`  TODAY: ${p.nextExercises.join(' · ')}`);
    }
    lines.push('');
    const va = ctx.volumeChangePct > 0 ? '↑' : ctx.volumeChangePct < 0 ? '↓' : '→';
    lines.push(`VOLUME: ${ctx.volumeThisWeek} reps this week vs ${ctx.volumeLastWeek} last week (${ctx.volumeChangePct >= 0 ? '+' : ''}${ctx.volumeChangePct}% ${va})`);
    if (ctx.recentLogs.length) {
      lines.push('');
      lines.push('RECENT SESSIONS:');
      ctx.recentLogs.slice(0, 10).forEach(l => {
        if (l.skipped) { lines.push(`  ${l.date}: SKIPPED (${l.exercise})`); return; }
        const vol = l.sets && l.reps ? ` ${l.sets}x${l.reps}` : '';
        const cal = l.calories ? ` ${Math.round(l.calories)} cal` : '';
        lines.push(`  ${l.date}: ${l.exercise} [${l.category}]${vol}, ${l.duration}min${cal}`);
      });
    }
    lines.push('');
    lines.push(`ACHIEVEMENTS: ${ctx.totalAchievements} earned | ${ctx.totalPoints} pts`);
    if (ctx.recentAchievement)    lines.push(`  Latest: "${ctx.recentAchievement}"`);
    if (ctx.nextAchievementHint)  lines.push(`  Next: "${ctx.nextAchievementHint}"`);
    lines.push('');
    lines.push(`MEMORY: Adherence ${memory.adherenceScore ?? 80}/100 | Fatigue ${memory.fatigueScore ?? 0}/10 | Msg #${memory.messageCount ?? 1}`);
    // Nutrition section
    lines.push('');
    lines.push(`NUTRITION TARGETS: ${ctx.dailyCalorieTarget} kcal | P:${ctx.dailyProteinTarget}g C:${ctx.dailyCarbTarget}g F:${ctx.dailyFatTarget}g`);
    if (ctx.todayNutrition) {
      const n  = ctx.todayNutrition;
      const pct = ctx.dailyCalorieTarget ? Math.round((n.calories / ctx.dailyCalorieTarget) * 100) : 0;
      lines.push(`TODAY'S INTAKE (${n.meals} meals): ${n.calories} kcal (${pct}%) | P:${n.protein}g C:${n.carbs}g F:${n.fat}g`);
      const proteinGap = (ctx.dailyProteinTarget ?? 0) - n.protein;
      if (proteinGap > 20) lines.push(`  ⚠ PROTEIN GAP: ${proteinGap}g still needed today`);
    } else {
      lines.push(`TODAY'S INTAKE: No meals logged yet`);
    }
    if (ctx.nutritionAdherence7d !== undefined) {
      lines.push(`NUTRITION ADHERENCE (7d): ${ctx.nutritionAdherence7d}%`);
    }
    lines.push('=== END CONTEXT ===');
    return lines.join('\n');
  }

  // GROQ LLM CALL
  private async callLLM(
    message: string, ctx: UserContext, memory: ConversationMemory, similar: string[],
  ): Promise<LLMStructured> {
    const contextBlock = this.formatContextBlock(ctx, memory);

    // Compute TDEE and fatigue context strings for the prompt
    const fatigue      = memory.fatigueScore ?? 0;
    const adherence    = memory.adherenceScore ?? 80;
    const inDeficit    = (ctx.dailyCalorieTarget ?? 9999) < (ctx.weight ?? 75) * 10 * 1.55 * 0.95;
    const proteinShort = ctx.todayNutrition
      ? (ctx.dailyProteinTarget ?? 0) - ctx.todayNutrition.protein > 20
      : false;
    const nutritionNote = inDeficit
      ? `Athlete is in a calorie deficit — if nutrition comes up, remind them protein floor is ${ctx.dailyProteinTarget ?? 140}g/day.`
      : `Athlete is in surplus or maintenance — carbs support performance on training days.`;
    const proteinNote = proteinShort
      ? `Athlete has a protein gap today (${(ctx.dailyProteinTarget ?? 0) - (ctx.todayNutrition?.protein ?? 0)}g short) — mention this only if nutrition is the topic.`
      : '';

    const systemPrompt = `You are FlowFit AI Coach — a world-class hybrid of an elite strength & conditioning coach, registered sports dietitian, and performance psychologist. You have full access to the athlete's real-time data below and MUST use it in every response.

━━ REASONING PROTOCOL (execute silently before every reply) ━━
1. ASSESS: What is the athlete's current state? (fatigue ${fatigue}/10, adherence ${adherence}/100, goal: ${ctx.fitnessGoal})
2. IDENTIFY: What is the single most important thing for this athlete RIGHT NOW?
3. CONNECT: Link your response directly to their real numbers (streak, volume %, metrics, macros).
4. PRESCRIBE: Give one specific, actionable recommendation — not generic advice.
5. ANTICIPATE: What will they need to hear next? Seed it briefly.

━━ COACHING INTELLIGENCE RULES ━━
FATIGUE LOGIC:
- Fatigue 0-3 → push intensity, progressive overload, add sets or load
- Fatigue 4-6 → maintain load, emphasise technique and mind-muscle connection
- Fatigue 7-8 → mandatory deload: -40% load, -50% volume, active recovery
- Fatigue 9-10 → full rest, sleep audit, nutrition check

PERIODISATION AWARENESS:
- If volume ↑ >20% for 2+ weeks → flag overreaching risk proactively
- If streak >21 days with no deload mentioned → recommend strategic rest week
- Match intensity prescription to program week (early weeks: technique, later weeks: peak load)

NUTRITION × TRAINING INTEGRATION:
- Pre-workout (1-2h before): 30-40g carbs + 20g protein → name specific foods
- Post-workout (within 45 min): 40-50g protein + fast carbs → name specific foods
- Context: ${nutritionNote}${proteinNote ? '\n- Note: ' + proteinNote : ''}
- Hydration: 35 ml/kg = ${Math.round((ctx.weight ?? 75) * 35)} ml/day for this athlete

BIOMECHANICS & EXERCISE SCIENCE:
- Reference RPE (Rate of Perceived Exertion 1-10) when prescribing intensity
- Apply progressive overload: 2.5% weight or 1 rep increase per session when RPE < 8
- Compound-first sequencing: squats/deads/press before isolation work
- Tempo prescription when correcting form: 3-1-2 (eccentric-pause-concentric)

KENYAN ATHLETE CONTEXT:
- Default foods: ugali, sukuma wiki, githeri, nyama choma, eggs, milk, beans, avocado
- Suggest locally available protein sources when giving meal advice
- Be aware of typical Kenyan meal patterns (2-3 main meals, chai culture)

PSYCHOLOGICAL COACHING:
- Adherence <60: focus entirely on habit, remove friction, celebrate any win
- Adherence 60-80: build momentum with small progressive challenges
- Adherence >80: push performance, set records, introduce periodisation
- Never shame missed sessions — reframe as data
- Use the athlete's name (${ctx.name}) naturally but not every message

━━ RESPONSE FORMAT — NON-NEGOTIABLE ━━
- ALWAYS answer what the athlete ACTUALLY ASKED — never redirect to nutrition unless they asked about it
- "response" field: 1–3 sentences MAX, 60 words hard limit, punchy and direct
- Use tools for ALL detailed output (plans, history, metrics, nutrition breakdowns)
- Never put bullet lists or headers inside "response" — that goes in tool output
- Omit "tool" key entirely when no tool is needed
- A greeting gets a greeting back — do NOT call any tool for casual messages

OUTPUT — valid JSON only, no markdown, no code fences:
{
  "intent": "<what athlete needs>",
  "tool": { "name": "<tool_name>", "args": {} },
  "response": "<1-3 punchy sentences max 60 words>"
}

Available tools:
  TRAINING:   generate_workout | next_workout | program_status | weekly_program
              workout_history | adaptive_adjustment | body_metrics | achievements
              streak_info | recovery_plan | log_workout
  NUTRITION (full): nutrition_plan → only when user asks for a FULL plan, meal schedule, or says "plan my diet"
              macro_calculator → only when user asks to calculate macros/calories/TDEE
              log_meal → when user wants to log/record food they ate
              nutrition_summary → when user asks how they are doing today, today's intake, progress
  NUTRITION (quick): quick_nutrition → for ANY short nutrition question: "what should I eat", "best food for X",
              "what to eat before/after workout", "is X good for my goal", "how much protein in X"
  NO TOOL: greetings, motivation, general chat, yes/no questions → answer directly in "response" field only

Never invent data. Always reference real numbers from context. "response" is always required.`;
    const userContent =
      contextBlock + '\n\n' +
      (similar.length ? `RELATED PAST MSGS:\n${similar.join('\n')}\n\n` : '') +
      `ATHLETE: ${message}`;

    const res = await fetchWithRetry(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.25, max_completion_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent  },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);

    const data = await res.json() as GroqChatResponse;
    const raw  = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Groq returned empty content');

    // Sanitize: LLM sometimes returns "tool": {} (no name) — strip it so Zod doesn't fail
    const parsed = safeJsonParse(raw) as any;
    if (parsed && typeof parsed === 'object') {
      if (parsed.tool !== undefined && !parsed.tool?.name) {
        delete parsed.tool;
      }
    }

    const result = LLMResponseSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[AICoach] validation failed:', result.error.message);
      // Extract just the response string — never expose raw JSON to the user
      const safeReply =
        typeof parsed?.response === 'string' && parsed.response.trim()
          ? parsed.response.trim()
          : 'How can I help with your training today?';
      return { intent: 'unknown', response: safeReply };
    }
    return result.data;
  }

  // EXECUTION
  private async execute(llm: LLMStructured, userId: string, ctx: UserContext, memory: ConversationMemory): Promise<CoachResponse> {
    const base = llm.response ?? 'How can I help with your training today?';
    if (!llm.tool) return { success: true, reply: base };
    const tool = await this.executeTool(llm.tool, userId, ctx, memory);
    return { success: true, reply: tool.reply || base, data: tool.data };
  }

  private async executeTool(tool: NonNullable<LLMStructured['tool']>, userId: string, ctx: UserContext, _memory: ConversationMemory): Promise<CoachResponse> {
    switch (tool.name) {
      case 'generate_workout':    return this.generateWorkout(ctx);
      case 'next_workout':        return this.nextWorkout(userId, ctx);
      case 'program_status':      return this.programStatus(ctx);
      case 'weekly_program':      return this.weeklyProgram(userId, ctx);
      case 'workout_history':     return this.workoutHistory(ctx);
      case 'adaptive_adjustment': return this.adaptiveAdjustment(userId, ctx);
      case 'body_metrics':        return this.bodyMetricsSummary(userId, ctx);
      case 'achievements':        return this.achievementsSummary(userId, ctx);
      case 'streak_info':         return this.streakSummary(ctx);
      case 'recovery_plan':       return this.recoveryPlan(ctx);
      case 'log_workout':         return this.logWorkout(userId, tool.args);
      case 'nutrition_plan':    return this.nutritionPlan(ctx);
      case 'macro_calculator':  return this.macroCalculator(ctx);
      case 'log_meal':          return this.logMeal(userId, tool.args);
      case 'nutrition_summary': return this.nutritionSummary(userId, ctx);
      case 'quick_nutrition':   return this.quickNutrition(ctx, tool.args);
      default: return { success: false, reply: 'That feature is coming soon.' };
    }
  }

  // ── TOOLS ──────────────────────────────────────────────────

  private generateWorkout(ctx: UserContext): CoachResponse {
  if (ctx.program?.nextExercises.length) {
    // Already handled by nextWorkout in most cases
    const list = ctx.program.nextExercises.map(e => `• **${e}**`).join('\n');
    return {
      success: true,
      reply: `**${ctx.program.title}** — Week ${ctx.program.currentWeek}, Day ${ctx.program.currentDay}\n\n${list}\n\nWarm up 5 min · Rest 60–90 s between sets\n\nTell me when you're done and I'll log it!`,
      data: { exercises: ctx.program.nextExercises, source: 'program' },
    };
  }

    type Def = { type: string; exercises: { name: string; sets: number; reps: string }[] };
    const workouts: Record<string, Def> = {
      beginner: {
        type: 'Beginner Full Body',
        exercises: [
          { name: 'Push-ups', sets: 3, reps: '8' },
          { name: 'Bodyweight Squats', sets: 3, reps: '12' },
          { name: 'Glute Bridge', sets: 3, reps: '12' },
          { name: 'Plank', sets: 3, reps: '30 s' },
          { name: 'Mountain Climbers', sets: 3, reps: '20' },
        ],
      },
      intermediate: {
        type: 'Intermediate Strength',
        exercises: [
          { name: 'Push-ups', sets: 4, reps: '15' },
          { name: 'Goblet Squat', sets: 4, reps: '12' },
          { name: 'Dumbbell Row', sets: 4, reps: '10 each' },
          { name: 'Romanian Deadlift', sets: 3, reps: '12' },
          { name: 'Plank', sets: 3, reps: '45 s' },
          { name: 'Lateral Raises', sets: 3, reps: '15' },
        ],
      },
      advanced: {
        type: 'Advanced Strength & Power',
        exercises: [
          { name: 'Barbell Squat', sets: 5, reps: '5' },
          { name: 'Bench Press', sets: 5, reps: '5' },
          { name: 'Barbell Deadlift', sets: 4, reps: '4' },
          { name: 'Pull-ups', sets: 4, reps: '8' },
          { name: 'Overhead Press', sets: 4, reps: '6' },
          { name: 'Farmer Carry', sets: 3, reps: '40 m' },
        ],
      },
    };

    const w = workouts[ctx.fitnessLevel] ?? workouts['intermediate'];

  const exercisesList = w.exercises.map(e =>
    `• **${e.name}** — ${e.sets}×${e.reps}`
  ).join('\n');

  const volNote = ctx.volumeChangePct < -10
    ? `\n\n📉 Volume is down — focus on completing every set today.`
    : ctx.volumeChangePct > 15 ? `\n\n📈 Great momentum! Build on it.` : '';

  const reply = `**${w.type}** — ${ctx.fitnessGoal.toUpperCase()}\n\n${exercisesList}${volNote}\n\nWarm up 5 min · Rest 60–90 s between sets\n\nTell me when you finish and I'll log it!`;

  return {
    success: true,
    reply,
    data: { workout: w, source: 'profile' },
  };
  }

  private async nextWorkout(userId: string, ctx: UserContext): Promise<CoachResponse> {
  if (!ctx.program) {
    return { success: true, reply: `You're not enrolled in a program. Want a custom session? Just say "give me a workout".` };
  }

  const enrollment = await prisma.programEnrollment.findFirst({
    where: { userId, isActive: true },
    include: {
      program: {
        include: {
          weeks: {
            where: { weekNumber: ctx.program!.currentWeek },
            include: {
              days: {
                where: { dayNumber: ctx.program!.currentDay },
                include: {
                  exercises: {
                    include: { exercise: { select: { name: true, description: true, category: true } } },
                    orderBy: { orderIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const dayEx = enrollment?.program.weeks[0]?.days[0]?.exercises ?? [];
  if (!dayEx.length) {
    return { success: true, reply: `Couldn't load today's exercises for **${ctx.program.title}**. Check the Programs page.` };
  }

  const exercisesList = dayEx.map((de, i) => {
    const desc = de.exercise.description ? ` — ${de.exercise.description}` : '';
    return `${i + 1}. **${de.exercise.name}** [${de.exercise.category}]${desc}`;
  }).join('\n');

  const fatNote = (ctx.fatigueScore ?? 0) >= 6
    ? `\n\n **Fatigue elevated** — reduce weight 10–15% and focus on form today.`
    : '';

  const reply = `**${ctx.program.title}** — Week ${ctx.program.currentWeek}, Day ${ctx.program.currentDay}\n\n` +
                `${exercisesList}\n\n` +
                `Warm up 5–7 minutes • Rest 60–90 seconds between sets${fatNote}\n\n` +
                `Tell me when you're done and I'll log it for you! `;

  return {
    success: true,
    reply,
    data: { exercises: dayEx.map(de => de.exercise), week: ctx.program.currentWeek, day: ctx.program.currentDay },
  };
  }
  

  private programStatus(ctx: UserContext): CoachResponse {
    if (!ctx.program) return { success: true, reply: `You're not enrolled in a program. Visit Programs to start one!` };
    const p = ctx.program;
    const daysLeft  = p.totalDays - p.completedDays;
    const weeksLeft = p.durationWeeks - p.currentWeek + 1;
    const streak = ctx.currentStreak > 0 ? `\n\n${ctx.currentStreak}-day streak — don't break it!` : '';
    return {
      success: true,
      reply: `**${p.title}**\n\nWeek ${p.currentWeek}/${p.durationWeeks}, Day ${p.currentDay}\n` +
        `${p.completedDays} done | ${daysLeft} remaining | ${p.pctComplete}% complete\n` +
        `${weeksLeft} week${weeksLeft !== 1 ? 's' : ''} left` +
        (p.nextExercises.length ? `\n\nToday: ${p.nextExercises.join(', ')}` : '') + streak,
      data: { program: p },
    };
  }

  private async weeklyProgram(userId: string, ctx: UserContext): Promise<CoachResponse> {
  if (!ctx.program) {
    return { success: true, reply: `No active program. Browse Programs to enroll.` };
  }

  const enrollment = await prisma.programEnrollment.findFirst({
    where: { userId, isActive: true },
    include: {
      program: {
        include: {
          weeks: {
            where: { weekNumber: ctx.program!.currentWeek },
            include: {
              days: {
                include: {
                  exercises: {
                    include: { exercise: { select: { name: true } } },
                    orderBy: { orderIndex: 'asc' },
                  },
                },
                orderBy: { dayNumber: 'asc' },
              },
            },
          },
        },
      },
    },
  });

  const days = enrollment?.program.weeks[0]?.days ?? [];
  if (!days.length) {
    return { success: true, reply: `Couldn't load this week's schedule.` };
  }

  const scheduleLines = days.map(d => {
    const exs = d.exercises.map(de => de.exercise.name).join(' · ');
    const isToday = d.dayNumber === ctx.program!.currentDay;
    
    const marker = isToday ? ' ← TODAY' : '';
    return `Day ${d.dayNumber}${marker}: ${exs}`;
  }).join('\n');

  const reply = `**${ctx.program.title}** — Week ${ctx.program.currentWeek}\n\n${scheduleLines}\n\n${ctx.program.completedDays}/${ctx.program.totalDays} sessions complete · ${ctx.program.pctComplete}% done`;

  return {
    success: true,
    reply,
    data: { days },
  };
  }
  
  private workoutHistory(ctx: UserContext): CoachResponse {
    const logs = ctx.recentLogs;
    if (!logs.length) return { success: true, reply: `No sessions in the last 14 days. Ready to start? Say "give me a workout".` };
    const done    = logs.filter(l => !l.skipped);
    const skipped = logs.filter(l =>  l.skipped);
    const avgDur  = done.length ? Math.round(done.reduce((s,l) => s + l.duration, 0) / done.length) : 0;
    const totalCal = done.reduce((s,l) => s + (l.calories ?? 0), 0);
    const cats: Record<string,number> = {};
    done.forEach(l => { cats[l.category] = (cats[l.category] ?? 0) + 1; });
    const catStr = Object.entries(cats).sort((a,b) => b[1]-a[1]).map(([c,n]) => `${c} (${n})`).join(', ');
    const va = ctx.volumeChangePct > 0 ? `↑ +${ctx.volumeChangePct}%` : ctx.volumeChangePct < 0 ? `↓ ${ctx.volumeChangePct}%` : '→ Steady';
    return {
      success: true,
      reply: `**Last 14 days:**\n\n` +
        `${done.length} sessions | avg ${avgDur} min | ~${Math.round(totalCal)} cal burned\n` +
        `Volume trend: ${va}\nCategories: ${catStr || 'Mixed'}` +
        (skipped.length ? `\n\n⚠️ ${skipped.length} skipped — let's protect those slots.` : ''),
      data: { completed: done.length, skipped: skipped.length, avgDuration: avgDur, totalCalories: Math.round(totalCal) },
    };
  }

  private async adaptiveAdjustment(userId: string, ctx: UserContext): Promise<CoachResponse> {
    const logs = await prisma.workoutLog.findMany({
      where: { userId, skipped: false }, orderBy: { date: 'desc' }, take: 10,
      include: { exercise: { select: { name: true, category: true } } },
    });
    if (logs.length < 3) return { success: true, reply: `Need at least 3 logged sessions. You have ${logs.length} — keep going!` };
    const fatigue = ctx.fatigueScore ?? 0;
    const vc = ctx.volumeChangePct;
    const s  = ctx.currentStreak;
    let intensity: 'increase'|'maintain'|'deload';
    let reason: string;
    if (fatigue >= 7) { intensity = 'deload'; reason = `Fatigue at ${fatigue}/10 — your body is asking for a break.`; }
    else if (vc > 20 && s >= 7) { intensity = 'increase'; reason = `Volume up ${vc}% and ${s}-day streak — ready for more.`; }
    else if (vc < -15) { intensity = 'maintain'; reason = `Volume dropped ${Math.abs(vc)}% — stabilise before loading more.`; }
    else if (s >= 14 && fatigue < 4) { intensity = 'increase'; reason = `${s} days consistent and fatigue is low — ideal time to progress.`; }
    else { intensity = 'maintain'; reason = 'Performance steady — consistency at this level builds a strong base.'; }
    const recs: Record<typeof intensity,string> = {
      increase: '• Add 2–2.5 kg to compounds or 2 reps per set\n• Add 1 extra working set to main movement\n• Reduce rest 15 s if form is solid',
      maintain: '• Keep weights and rep ranges the same\n• Focus on form and mind-muscle connection\n• Prioritise sleep and protein this week',
      deload:   '• Reduce weights 40–50%\n• Cut volume by half (2–3 sets max)\n• Prioritise mobility, stretching, sleep\n• Return full intensity in 5–7 days',
    };
    return {
      success: true,
      reply: `**Adjustment: ${intensity.toUpperCase()}**\n\n${reason}\n\n${recs[intensity]}`,
      data: { intensity, volumeChange: vc, fatigue, streak: s },
    };
  }

  private async bodyMetricsSummary(userId: string, ctx: UserContext): Promise<CoachResponse> {
    const metrics = await prisma.userMetrics.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 10 });
    if (!metrics.length) return { success: true, reply: `No metrics logged yet. Add your weight and measurements in the Progress page to unlock insights.` };
    const l = metrics[0], o = metrics[metrics.length - 1];
    const wChange  = l.weight  && o.weight  ? Math.round((l.weight  - o.weight)  * 10) / 10 : null;
    const bfChange = l.bodyFat && o.bodyFat ? Math.round((l.bodyFat - o.bodyFat) * 10) / 10 : null;
    const lines = [`**Body Metrics — ${fmtDate(l.date)}:**\n`];
    if (l.weight)    lines.push(`Weight: ${l.weight} kg${wChange != null ? ` (${wChange >= 0 ? '+' : ''}${wChange} kg since first log)` : ''}`);
    if (ctx.targetWeight) lines.push(`Target: ${ctx.targetWeight} kg${l.weight ? ` (${Math.abs(l.weight - ctx.targetWeight).toFixed(1)} kg to go)` : ''}`);
    if (l.bodyFat)   lines.push(`Body Fat: ${l.bodyFat}%${bfChange != null ? ` (${bfChange >= 0 ? '+' : ''}${bfChange}%)` : ''}`);
    if (l.muscleMass) lines.push(`Muscle Mass: ${l.muscleMass} kg`);
    if (l.bmi)       lines.push(`BMI: ${l.bmi.toFixed(1)}`);
    if (l.restingHeartRate) lines.push(`Resting HR: ${l.restingHeartRate} bpm`);
    if (wChange != null) {
      const goalLoss = ctx.fitnessGoal?.toLowerCase().includes('loss') || ctx.fitnessGoal?.toLowerCase().includes('cut');
      lines.push(goalLoss ? (wChange < 0 ? '\n✅ On track' : '\n⚠️ Review nutrition') : (wChange > 0 ? '\n✅ Gaining as planned' : '\nHold current approach'));
    }
    return { success: true, reply: lines.join('\n'), data: { latest: l } };
  }

  private async achievementsSummary(userId: string, ctx: UserContext): Promise<CoachResponse> {
    const earned = await prisma.userAchievement.findMany({
      where: { userId }, include: { achievement: true },
      orderBy: { unlockedAt: 'desc' }, take: 20,
    });
    if (!earned.length) return { success: true, reply: `No achievements yet! Log 3 workouts this week to earn your first badge.${ctx.nextAchievementHint ? `\n\nFirst up: "${ctx.nextAchievementHint}"` : ''}` };
    const list = earned.slice(0, 5).map(a =>
      `🏅 **${a.achievement.name}** — ${a.achievement.description} *(${fmtDate(a.unlockedAt)})*`
    ).join('\n');
    return {
      success: true,
      reply: `**Achievements** — ${ctx.totalAchievements} earned | ${ctx.totalPoints} pts:\n\n${list}` +
        (ctx.nextAchievementHint ? `\n\n**Next:** ${ctx.nextAchievementHint}` : ''),
      data: { total: ctx.totalAchievements, points: ctx.totalPoints },
    };
  }

  private streakSummary(ctx: UserContext): CoachResponse {
    const { currentStreak: cs, longestStreak: ls, lastWorkoutDate: lwd } = ctx;
    let msg = cs === 0 ? 'No active streak — start today! Even 5 minutes counts.'
      : cs >= ls && cs > 7 ? `${cs} days — new personal best! 🏆`
      : cs >= 7 ? `${cs}-day streak! Best is ${ls} — ${ls - cs} days to beat it.`
      : `${cs}-day streak. Best: ${ls} days. Let's beat it.`;
    if (lwd) msg += `\n\nLast session: ${lwd}`;
    return { success: true, reply: msg, data: { currentStreak: cs, longestStreak: ls } };
  }

  private recoveryPlan(ctx: UserContext): CoachResponse {
    const fatigue = ctx.fatigueScore ?? 0;
    const full = fatigue >= 7 || ctx.volumeChangePct > 25;
    const reply = full
      ? `**Full Recovery Day:**\n\n• No heavy lifting\n• Foam roll 15 min (legs, lats, hips)\n• Static stretching 10 min\n• 20 min walk or light swim\n• 2–3 L water | ${ctx.weight ? Math.round(ctx.weight * 1.8) : 140}g protein goal\n• 8–9 hrs sleep${fatigue >= 7 ? '\n\n⚠️ Take 2 full rest days if soreness persists.' : ''}`
      : `**Active Recovery:**\n\n• 10 min dynamic warm-up\n• Foam roll 10 min\n• Mobility circuit 15 min (hip openers, shoulder CARs, thoracic rotation)\n• 15 min zone 2 cardio (conversational pace)\n• Static stretch cooldown 10 min`;
    return { success: true, reply, data: { intensity: full ? 'full' : 'light', fatigue } };
  }

  private async logWorkout(userId: string, args: any): Promise<CoachResponse> {
    const { exerciseId = null, exerciseName = null, sets = 3, reps = 10,
            duration = 30, notes = '', caloriesBurned = null, heartRate = null, difficulty = null } = args ?? {};
    let resolvedId = exerciseId;
    if (!resolvedId && exerciseName) {
      const found = await prisma.exercise.findFirst({
        where: { name: { contains: exerciseName, mode: 'insensitive' }, isActive: true },
        select: { id: true },
      });
      if (found) resolvedId = found.id;
    }
    if (!resolvedId) {
      return { success: false, reply: `Couldn't find that exercise. Try "log bench press 4 sets 8 reps" or log directly in Workouts.` };
    }
    await prisma.workoutLog.create({
      data: {
        userId, exerciseId: resolvedId, duration, sets, reps,
        notes: notes || null,
        caloriesBurned: caloriesBurned ? parseFloat(caloriesBurned) : null,
        heartRate:      heartRate ? parseInt(heartRate) : null,
        difficulty: difficulty || null, completed: true, skipped: false,
      },
    });
    return {
      success: true,
      reply: `✅ Logged! **${sets}×${reps}** ${exerciseName ?? 'exercise'} (${duration} min). Consistency is the compound interest of fitness. 💪`,
    };
  }

  // ── NUTRITION TOOLS ────────────────────────────────────────────────────────

  private nutritionPlan(ctx: UserContext): CoachResponse {
    const goal   = (ctx.fitnessGoal ?? '').toLowerCase();
    const weight = ctx.weight ?? 75;
    const cal    = ctx.dailyCalorieTarget ?? 2000;
    const pro    = ctx.dailyProteinTarget ?? 140;
    const carb   = ctx.dailyCarbTarget   ?? 200;
    const fat    = ctx.dailyFatTarget    ?? 55;

    const isLoss = goal.includes('loss') || goal.includes('cut');
    const isGain = goal.includes('muscle') || goal.includes('gain') || goal.includes('bulk');

    // Meal timing based on workout presence
    const hasWorkoutToday = ctx.recentLogs.some(l =>
      l.date === new Date().toLocaleDateString('en-KE', { weekday: 'short', month: 'short', day: 'numeric' }) && !l.skipped
    );

    const meals = [
      {
        name:  'Breakfast (7–8 AM)',
        foods: isGain
          ? '4 eggs scrambled + 2 slices bread + 1 cup milk + 1 banana'
          : isLoss
          ? '3 eggs boiled + sukuma wiki + black tea (no sugar)'
          : '3 eggs + 2 slices bread + 1 avocado + chai',
        macros: isGain ? '~520 kcal | P:32g C:45g F:18g' : isLoss ? '~280 kcal | P:22g C:8g F:16g' : '~420 kcal | P:24g C:36g F:18g',
      },
      {
        name:  hasWorkoutToday ? 'Pre-Workout (1–2h before training)' : 'Mid-Morning Snack',
        foods: hasWorkoutToday
          ? '1 cup githeri + 1 banana + 250 ml water'
          : '1 cup milk + 1 handful groundnuts',
        macros: hasWorkoutToday ? '~380 kcal | P:14g C:62g F:6g' : '~220 kcal | P:10g C:12g F:14g',
      },
      {
        name:  'Lunch (1–2 PM)',
        foods: isGain
          ? 'Ugali (4 pieces) + beef stew 150g + sukuma wiki + avocado'
          : isLoss
          ? 'Brown rice 1 cup + grilled chicken 120g + cucumber + tomato salad'
          : 'Ugali (2 pieces) + chicken 100g + mixed vegetables',
        macros: isGain ? '~780 kcal | P:42g C:88g F:22g' : isLoss ? '~420 kcal | P:35g C:48g F:8g' : '~580 kcal | P:32g C:68g F:14g',
      },
      {
        name:  hasWorkoutToday ? 'Post-Workout (within 45 min)' : 'Afternoon Snack',
        foods: hasWorkoutToday
          ? '2 boiled eggs + 1 cup milk + 1 banana — prioritise within 45 min of session'
          : '1 cup yoghurt + fruit',
        macros: hasWorkoutToday ? '~320 kcal | P:24g C:34g F:10g' : '~180 kcal | P:8g C:28g F:4g',
      },
      {
        name:  'Dinner (7–8 PM)',
        foods: isGain
          ? 'Rice 1.5 cups + lentils 1 cup + beef 100g + avocado'
          : isLoss
          ? 'Sukuma wiki + 2 eggs + 1 cup beans (no ugali) + lemon water'
          : 'Ugali (2 pieces) + fish 100g + sukuma wiki',
        macros: isGain ? '~680 kcal | P:38g C:82g F:18g' : isLoss ? '~340 kcal | P:28g C:32g F:10g' : '~480 kcal | P:28g C:56g F:12g',
      },
    ];

    const mealLines = meals.map(m => `**${m.name}**\n${m.foods}\n_${m.macros}_`).join('\n\n');

    const hydration = Math.round(weight * 35);
    const tips = isLoss
      ? '• Eat protein first at every meal to hit your floor\n• Avoid liquid calories — water, black tea only\n• Sleep 7–9 hrs — cortisol spikes destroy fat loss'
      : isGain
      ? '• Never skip a meal — surplus requires consistency\n• Add groundnuts or avocado to boost calories without volume\n• Eat within 30 min of waking'
      : '• Time carbs around workouts for best performance\n• Aim for protein at every meal\n• Consistent meal times improve adherence';

    return {
      success: true,
      reply: `**Personalised Nutrition Plan — ${ctx.fitnessGoal.toUpperCase()}**\n\n` +
        `**Daily Targets:** ${cal} kcal | Protein: ${pro}g | Carbs: ${carb}g | Fat: ${fat}g\n` +
        `**Hydration:** ${hydration} ml/day (${Math.round(hydration/250)} glasses)\n\n` +
        mealLines + '\n\n' +
        `**Key Rules:**\n${tips}`,
      data: { targets: { calories: cal, protein: pro, carbs: carb, fat }, meals },
    };
  }

  private quickNutrition(ctx: UserContext, args: any): CoachResponse {
    const question = (args?.question ?? '').toLowerCase();
    const goal     = (ctx.fitnessGoal ?? '').toLowerCase();
    const weight   = ctx.weight ?? 75;
    const isLoss   = goal.includes('loss') || goal.includes('cut');
    const isGain   = goal.includes('muscle') || goal.includes('gain') || goal.includes('bulk');

    // ── Pre/during/post workout questions ─────────────────────────────────────
    if (/before|pre.?workout|pre workout|prior to/.test(question)) {
      return {
        success: true,
        reply: `**Pre-workout (1–2h before):**\n\n` +
          `• 1 banana + 2 boiled eggs — fast carbs + protein\n` +
          `• Or: 1 cup githeri + black tea\n` +
          `• Or: 2 slices bread + peanut butter\n\n` +
          `Aim for **30–40g carbs + 20g protein**. Avoid heavy fats — they slow digestion and kill your energy mid-session.`,
      };
    }

    if (/after|post.?workout|post workout|recovery|when.*done|finish/.test(question)) {
      return {
        success: true,
        reply: `**Post-workout (within 45 min — critical window):**\n\n` +
          `• 3 boiled eggs + 1 banana + 1 cup milk → ~38g protein\n` +
          `• Or: 150g nyama choma + ugali (1 piece)\n` +
          `• Or: 1 cup beans + 2 eggs + chai\n\n` +
          `Target **40–50g protein + fast carbs**. This is when your muscles absorb nutrients fastest — don't skip it.`,
      };
    }

    if (/during|while.*workout|burpee|hiit|cardio|running|circuit/.test(question)) {
      return {
        success: true,
        reply: `**During high-intensity sessions (burpees, HIIT, circuits):**\n\n` +
          `• Sip water every 15 min — ${Math.round(weight * 35 / 1000 * 0.25 * 1000)} ml per hour\n` +
          `• If session is over 60 min: 1 banana or handful of dates at the halfway point\n` +
          `• No heavy food mid-workout — blood goes to muscles, not digestion\n\n` +
          `Fuel the session 1–2h before, recover within 45 min after. During is just water.`,
      };
    }

    // ── "What should I eat today" ─────────────────────────────────────────────
    if (/what.*eat.*(today|now)|today.*eat|eat.*today/.test(question) || question.trim() === '') {
      const remaining = ctx.todayNutrition
        ? (ctx.dailyCalorieTarget ?? 2000) - ctx.todayNutrition.calories
        : ctx.dailyCalorieTarget ?? 2000;
      const proteinLeft = ctx.todayNutrition
        ? (ctx.dailyProteinTarget ?? 140) - ctx.todayNutrition.protein
        : ctx.dailyProteinTarget ?? 140;
      const mealsLogged = ctx.todayNutrition?.meals ?? 0;

      const suggestion = isLoss
        ? `eggs + sukuma wiki + black tea for breakfast, grilled chicken + brown rice for lunch, beans + vegetables for dinner`
        : isGain
        ? `4 eggs + bread + milk for breakfast, ugali + beef stew + avocado for lunch, rice + lentils + chicken for dinner`
        : `3 eggs + avocado + chai for breakfast, ugali + chicken + vegetables for lunch, fish + sukuma wiki for dinner`;

      return {
        success: true,
        reply: `**Today's eating guide — ${ctx.fitnessGoal.toUpperCase()}**\n\n` +
          (mealsLogged > 0
            ? `You've logged ${mealsLogged} meal${mealsLogged !== 1 ? 's' : ''} — **${Math.round(remaining)} kcal** and **${Math.round(proteinLeft)}g protein** remaining.\n\n`
            : `No meals logged yet — target is **${ctx.dailyCalorieTarget} kcal** and **${ctx.dailyProteinTarget}g protein**.\n\n`) +
          `Try: ${suggestion}.\n\n` +
          `Want the full meal plan? Say "give me my full nutrition plan".`,
      };
    }

    // ── Protein questions ─────────────────────────────────────────────────────
    if (/protein|muscle.*food|food.*muscle|build.*muscle/.test(question)) {
      const target = ctx.dailyProteinTarget ?? Math.round(weight * 2);
      return {
        success: true,
        reply: `**Best protein sources for you — ${target}g/day target:**\n\n` +
          `• Eggs (6g each) — cheapest per gram in Kenya\n` +
          `• Nyama choma / beef (26g/100g)\n` +
          `• Tilapia / fish (22g/100g)\n` +
          `• Milk 1 cup (8g) — easy extra protein\n` +
          `• Beans / lentils (9g/100g cooked) — pair with eggs to complete amino acids\n` +
          `• Groundnuts (7g/30g handful)\n\n` +
          `Hit protein FIRST at every meal before filling up on carbs.`,
      };
    }

    // ── Weight loss food questions ─────────────────────────────────────────────
    if (/lose|loss|cut|deficit|fat.*burn|burn.*fat|slim/.test(question)) {
      return {
        success: true,
        reply: `**Best foods for fat loss:**\n\n` +
          `✅ Eat more: eggs, sukuma wiki, fish, beans, cucumber, tomatoes, black tea\n` +
          `❌ Cut back: ugali portions, white bread, soda, juice, sugar in chai\n\n` +
          `Rule: **protein at every meal** (keeps you full + preserves muscle). Reduce ugali to 1–2 pieces per meal instead of 4. You'll hit your ${ctx.dailyCalorieTarget} kcal target without feeling empty.`,
      };
    }

    // ── Weight gain / bulking questions ───────────────────────────────────────
    if (/gain|bulk|mass|weight.*up|skinny|underweight/.test(question)) {
      return {
        success: true,
        reply: `**Best foods to gain muscle mass:**\n\n` +
          `• Ugali + beef stew + avocado — high cal, easy to eat\n` +
          `• Whole milk (2–3 cups/day adds ~450 kcal)\n` +
          `• Groundnuts and avocado — dense calories without feeling stuffed\n` +
          `• Rice + lentils + chicken — complete amino acid profile\n\n` +
          `Your target is **${ctx.dailyCalorieTarget} kcal**. The key is consistency — eat even when not hungry. Add groundnuts or avocado to every meal to boost calories without volume.`,
      };
    }

    // ── Hydration ─────────────────────────────────────────────────────────────
    if (/water|hydrat|drink/.test(question)) {
      const ml = Math.round(weight * 35);
      return {
        success: true,
        reply: `**Hydration for ${weight}kg:**\n\n` +
          `• Daily target: **${ml} ml** (~${Math.round(ml / 250)} glasses)\n` +
          `• On training days: add 500 ml extra\n` +
          `• Morning: 500 ml before breakfast\n` +
          `• Signs of dehydration: dark urine, headache, poor performance\n\n` +
          `Chai counts — but limit sugar. Soda and juice do NOT count toward hydration.`,
      };
    }

    // ── Specific exercise nutrition (burpees, squats, etc) ───────────────────
    if (/squat|deadlift|bench|lift|strength|weights/.test(question)) {
      return {
        success: true,
        reply: `**Eating for strength training:**\n\n` +
          `• 2h before: ugali (2 pieces) + 2 eggs or beans — slow carbs + protein\n` +
          `• Within 45 min after: 3 eggs + milk + banana — repair and grow\n` +
          `• Daily: hit your **${ctx.dailyProteinTarget ?? Math.round(weight * 2)}g protein** — without it, sessions build nothing\n\n` +
          `Progressive overload + protein = muscle. You can't out-train a protein deficit.`,
      };
    }

    // ── Fallback for unmatched short nutrition questions ─────────────────────
    const proteinTarget = ctx.dailyProteinTarget ?? Math.round(weight * 2);
    const calTarget     = ctx.dailyCalorieTarget ?? 2000;
    return {
      success: true,
      reply: `**Quick answer for your goal (${ctx.fitnessGoal}):**\n\n` +
        `Targets: **${calTarget} kcal | ${proteinTarget}g protein** per day.\n\n` +
        isLoss
          ? `Focus on: eggs, fish, sukuma wiki, beans. Cut ugali portions in half. Protein first at every meal.`
          : isGain
          ? `Focus on: ugali + beef + milk + avocado. Never skip meals. Eat within 30 min of waking.`
          : `Balance carbs around workouts. Protein at every meal. Consistent timing beats perfect eating.`,
    };
        }

  private macroCalculator(ctx: UserContext): CoachResponse {
    const weight = ctx.weight ?? 75;
    const height = ctx.height ?? 175;
    const age    = ctx.ageYears ?? 30;
    const isMale = (ctx.gender ?? '').toLowerCase() !== 'female';
    const goal   = (ctx.fitnessGoal ?? '').toLowerCase();

    // Mifflin-St Jeor BMR
    const bmr = isMale
      ? 10 * weight + 6.25 * height - 5 * age + 5
      : 10 * weight + 6.25 * height - 5 * age - 161;

    const activityMultipliers = {
      sedentary:     1.2,
      light:         1.375,
      moderate:      1.55,
      active:        1.725,
      veryActive:    1.9,
    };
    // Infer activity from streak and volume
    const streak = ctx.currentStreak ?? 0;
    const mult = streak >= 5 ? activityMultipliers.active
      : streak >= 3 ? activityMultipliers.moderate
      : activityMultipliers.light;

    const tdee = Math.round(bmr * mult);
    const deficit  = Math.round(tdee * 0.82);
    const surplus  = Math.round(tdee * 1.12);
    const maintain = tdee;

    const recommended = goal.includes('loss') || goal.includes('cut') ? deficit
      : goal.includes('muscle') || goal.includes('gain') ? surplus
      : maintain;

    const proteinG = Math.round(weight * 2);
    const fatG     = Math.round((recommended * 0.25) / 9);
    const carbG    = Math.round((recommended - proteinG * 4 - fatG * 9) / 4);

    const weeklyChange = goal.includes('loss') ? `~${Math.round((tdee - recommended) * 7 / 7700 * 10) / 10} kg/week loss`
      : goal.includes('gain') ? `~${Math.round((recommended - tdee) * 7 / 7700 * 10) / 10} kg/week gain`
      : 'Weight maintenance';

    return {
      success: true,
      reply: `**Macro Calculator — ${ctx.name}**\n\n` +
        `**Stats:** ${weight} kg | ${height} cm | ${age} yrs | ${isMale ? 'Male' : 'Female'}\n\n` +
        `**BMR:** ${Math.round(bmr)} kcal | **TDEE (${streak >= 5 ? 'Active' : streak >= 3 ? 'Moderate' : 'Light'}):** ${tdee} kcal\n\n` +
        `| Scenario | Calories | Protein | Carbs | Fat |\n` +
        `|---|---|---|---|---|\n` +
        `| Cut (−18%) | ${deficit} | ${proteinG}g | ${Math.round((deficit - proteinG*4 - Math.round(deficit*0.25/9)*9)/4)}g | ${Math.round(deficit*0.25/9)}g |\n` +
        `| **Maintain** | **${maintain}** | **${proteinG}g** | **${Math.round((maintain - proteinG*4 - Math.round(maintain*0.25/9)*9)/4)}g** | **${Math.round(maintain*0.25/9)}g** |\n` +
        `| Bulk (+12%) | ${surplus} | ${proteinG}g | ${Math.round((surplus - proteinG*4 - Math.round(surplus*0.25/9)*9)/4)}g | ${Math.round(surplus*0.25/9)}g |\n\n` +
        `**Your target (${ctx.fitnessGoal}):** ${recommended} kcal → ${weeklyChange}\n` +
        `**Set macros:** ${proteinG}g protein · ${carbG}g carbs · ${fatG}g fat`,
      data: { bmr: Math.round(bmr), tdee, recommended, macros: { protein: proteinG, carbs: carbG, fat: fatG } },
    };
  }

  private async logMeal(userId: string, args: any): Promise<CoachResponse> {
    const {
      mealName   = 'Meal',
      calories   = null,
      protein    = null,
      carbs      = null,
      fat        = null,
      mealType   = 'OTHER', // BREAKFAST | LUNCH | DINNER | SNACK | PRE_WORKOUT | POST_WORKOUT
    } = args ?? {};

    if (!calories && !protein) {
      return {
        success: false,
        reply: `Tell me more — e.g. "log 3 eggs and ugali: 480 calories, 28g protein". I need at least calories or protein to log.`,
      };
    }

    try {
      const nutritionLog = (prisma as any).nutritionLog;
      if (!nutritionLog) {
        return { success: false, reply: `Nutrition tracking isn't set up yet. Ask your admin to run the database migration.` };
      }
      await nutritionLog.create({
        data: {
          userId,
          name:     mealName,
          calories: calories ? parseFloat(calories) : null,
          protein:  protein  ? parseFloat(protein)  : null,
          carbs:    carbs    ? parseFloat(carbs)    : null,
          fat:      fat      ? parseFloat(fat)      : null,
          mealType: mealType.toUpperCase(),
          date:     new Date(),
        },
      });

      const parts = [
        calories ? `${Math.round(calories)} kcal` : null,
        protein  ? `${Math.round(protein)}g protein` : null,
        carbs    ? `${Math.round(carbs)}g carbs` : null,
        fat      ? `${Math.round(fat)}g fat` : null,
      ].filter(Boolean).join(' · ');

      return {
        success: true,
        reply: `✅ **${mealName}** logged — ${parts}. Every meal tracked is a step closer to your goal.`,
      };
    } catch (err: any) {
      console.error('[AICoach] logMeal error:', err?.message);
      return { success: false, reply: `Couldn't log the meal right now. Try again or use the Nutrition page directly.` };
    }
  }

  private async nutritionSummary(userId: string, ctx: UserContext): Promise<CoachResponse> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let logs: any[] = [];
    try {
      const nutritionLog = (prisma as any).nutritionLog;
      if (!nutritionLog) {
        return { success: true, reply: `Nutrition tracking isn't set up yet. Run the database migration to enable meal logging.` };
      }
      logs = await nutritionLog.findMany({
        where:   { userId, date: { gte: todayStart } },
        orderBy: { date: 'asc' },
      });
    } catch {
      return { success: true, reply: `No nutrition logs found. Say "log my breakfast" to start tracking your food.` };
    }

    if (!logs.length) {
      const proteinTarget = ctx.dailyProteinTarget ?? 140;
      return {
        success: true,
        reply: `No meals logged yet today. Your targets: **${ctx.dailyCalorieTarget} kcal** | **${proteinTarget}g protein** | ${ctx.dailyCarbTarget}g carbs | ${ctx.dailyFatTarget}g fat.\n\nStart by logging breakfast — say "log 3 eggs and chai: 320 calories, 22g protein".`,
      };
    }

    const totals = logs.reduce((s: any, m: any) => ({
      calories: s.calories + (m.calories ?? 0),
      protein:  s.protein  + (m.protein  ?? 0),
      carbs:    s.carbs    + (m.carbs    ?? 0),
      fat:      s.fat      + (m.fat      ?? 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const calTarget  = ctx.dailyCalorieTarget ?? 2000;
    const proTarget  = ctx.dailyProteinTarget ?? 140;
    const carbTarget = ctx.dailyCarbTarget    ?? 200;
    const fatTarget  = ctx.dailyFatTarget     ?? 55;

    const calRemain  = calTarget  - Math.round(totals.calories);
    const proRemain  = proTarget  - Math.round(totals.protein);
    const carbRemain = carbTarget - Math.round(totals.carbs);
    const fatRemain  = fatTarget  - Math.round(totals.fat);

    const calPct  = Math.min(Math.round((totals.calories / calTarget)  * 100), 100);
    const proPct  = Math.min(Math.round((totals.protein  / proTarget)  * 100), 100);

    const mealLines = logs.map((m: any) => {
      const parts = [
        m.calories ? `${Math.round(m.calories)} kcal` : null,
        m.protein  ? `P:${Math.round(m.protein)}g`    : null,
        m.carbs    ? `C:${Math.round(m.carbs)}g`      : null,
        m.fat      ? `F:${Math.round(m.fat)}g`        : null,
      ].filter(Boolean).join(' | ');
      const type = m.mealType ? `[${m.mealType}] ` : '';
      return `• ${type}**${m.name}** — ${parts}`;
    }).join('\n');

    const proteinAlert = proRemain > 30
      ? `\n\n⚠️ **Protein gap: ${proRemain}g remaining** — add eggs, milk, or beans to your next meal.`
      : proRemain <= 0 ? `\n\n✅ Protein target hit!` : '';

    const calorieStatus = calRemain < 0
      ? `\n\n🔴 Over by ${Math.abs(calRemain)} kcal — adjust dinner or skip evening snack.`
      : calRemain < 200 ? `\n\n✅ Nearly at calorie target.`
      : `\n\n${calRemain} kcal remaining for today.`;

    return {
      success: true,
      reply: `**Today's Nutrition (${logs.length} meal${logs.length !== 1 ? 's' : ''} logged)**\n\n` +
        mealLines + '\n\n' +
        `**Totals:** ${Math.round(totals.calories)} / ${calTarget} kcal (${calPct}%) | P: ${Math.round(totals.protein)} / ${proTarget}g (${proPct}%)\n` +
        `Carbs: ${Math.round(totals.carbs)} / ${carbTarget}g | Fat: ${Math.round(totals.fat)} / ${fatTarget}g` +
        proteinAlert + calorieStatus +
        (ctx.nutritionAdherence7d !== undefined ? `\n\n📊 7-day logging adherence: **${ctx.nutritionAdherence7d}%**` : ''),
      data: { totals: Object.fromEntries(Object.entries(totals).map(([k,v]) => [k, Math.round(v as number)])), remaining: { calories: calRemain, protein: proRemain, carbs: carbRemain, fat: fatRemain } },
    };
  }

  // EMBEDDINGS
  private generateEmbedding(text: string): number[] {
    const v = new Array<number>(EMBED_DIMS).fill(0);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      let wh = 5381;
      for (let i = 0; i < w.length; i++) wh = ((wh << 5) + wh + w.charCodeAt(i)) >>> 0;
      for (let d = 0; d < Math.min(8, EMBED_DIMS); d++) v[(wh + d * 37) % EMBED_DIMS] += 1/(d+1);
      for (let i = 0; i < w.length - 1; i++) {
        let bh = 5381;
        bh = ((bh << 5) + bh + w.charCodeAt(i)) >>> 0;
        bh = ((bh << 5) + bh + w.charCodeAt(i+1)) >>> 0;
        v[bh % EMBED_DIMS] += 0.5;
      }
      for (let i = 0; i < w.length - 2; i++) {
        let th = 5381;
        th = ((th << 5) + th + w.charCodeAt(i)) >>> 0;
        th = ((th << 5) + th + w.charCodeAt(i+1)) >>> 0;
        th = ((th << 5) + th + w.charCodeAt(i+2)) >>> 0;
        v[th % EMBED_DIMS] += 0.25;
      }
    }
    const mag = Math.sqrt(v.reduce((s, x) => s + x*x, 0));
    if (mag > 0) for (let i = 0; i < EMBED_DIMS; i++) v[i] /= mag;
    return v;
  }

  private async storeEmbedding(userId: string, text: string, vector: number[]): Promise<void> {
    await prisma.embedding.create({ data: { userId, text, vector } });
    const count = await prisma.embedding.count({ where: { userId } });
    if (count > MAX_EMBEDDINGS) {
      const old = await prisma.embedding.findMany({
        where: { userId }, orderBy: { createdAt: 'asc' }, take: count - MAX_EMBEDDINGS, select: { id: true },
      });
      await prisma.embedding.deleteMany({ where: { id: { in: old.map(e => e.id) } } });
    }
  }

  private async semanticSearch(userId: string, q: number[]): Promise<string[]> {
    const rows = await prisma.embedding.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: MAX_EMBEDDINGS });
    return rows.map(r => ({ text: r.text, score: this.cos(q, r.vector as number[]) }))
      .sort((a,b) => b.score - a.score).slice(0, 5).map(r => r.text);
  }

  private cos(a: number[], b: number[]): number {
    if (a.length !== b.length || !a.length) return 0;
    let dot=0, mA=0, mB=0;
    for (let i=0; i<a.length; i++) { dot+=a[i]*b[i]; mA+=a[i]*a[i]; mB+=b[i]*b[i]; }
    const d = Math.sqrt(mA)*Math.sqrt(mB);
    return d === 0 ? 0 : dot/d;
  }

  // BEHAVIOUR
  private updateBehavior(memory: ConversationMemory, message: string): void {
    const lower = message.toLowerCase();
    if (/skip|miss|skipped|missed|couldn.t|can.t/.test(lower)) {
      memory.adherenceScore = Math.max(0,   (memory.adherenceScore ?? 100) - 5);
      memory.fatigueScore   = Math.min(10,  (memory.fatigueScore   ?? 0)   + 1);
    } else if (/completed|done|finished|crushed|nailed|smashed/.test(lower)) {
      memory.adherenceScore = Math.min(100, (memory.adherenceScore ?? 50)  + 3);
      memory.fatigueScore   = Math.max(0,   (memory.fatigueScore   ?? 0)   - 1);
    } else {
      memory.adherenceScore = Math.min(100, (memory.adherenceScore ?? 50)  + 1);
    }
    if (/tired|exhausted|sore|fatigue|burnout/.test(lower))           memory.fatigueScore = Math.min(10, (memory.fatigueScore ?? 0) + 2);
    else if (/rested|recovered|fresh|great|energized/.test(lower))    memory.fatigueScore = Math.max(0,  (memory.fatigueScore ?? 0) - 2);
  }

  // MEMORY
  private async loadMemory(userId: string): Promise<ConversationMemory> {
    const row = await prisma.userMemory.findUnique({ where: { userId } });
    return (row?.data as ConversationMemory) ?? {};
  }

  private async saveMemory(userId: string, memory: ConversationMemory): Promise<void> {
    await prisma.userMemory.upsert({
      where:  { userId },
      update: { data: memory as any },
      create: { userId, data: memory as any },
    });
  }
}

export const aiCoach = new AICoachService();
