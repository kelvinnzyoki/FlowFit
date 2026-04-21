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
  | 'log_workout';

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
    const [
      profile, subscription, enrollment,
      recentLogs, thisWeekLogs, lastWeekLogs,
      metrics, oldMetric, achievements, streak,
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
    lines.push('=== END CONTEXT ===');
    return lines.join('\n');
  }

  // GROQ LLM CALL
  private async callLLM(
    message: string, ctx: UserContext, memory: ConversationMemory, similar: string[],
  ): Promise<LLMStructured> {
    const contextBlock = this.formatContextBlock(ctx, memory);
    const systemPrompt = `You are FlowFit's AI coach — data-driven, direct, and specific. Use the athlete's REAL data.

PRINCIPLES:
- Reference real numbers: program name, exercise names, streak count, volume %
- Tone: honest training partner, never sycophantic
- Fatigue > 6: steer toward recovery
- Adherence < 60: prioritise consistency over intensity
- Coaching: ${ctx.hasCoaching} | Nutrition: ${ctx.hasNutrition}

RESPONSE LENGTH — CRITICAL:
- "response" = 1 to 3 SHORT sentences only. Hard limit: 60 words.
- No long paragraphs. No bullet lists inside "response".
- If detail is needed, use a tool — keep "response" punchy.

OUTPUT — valid JSON only, no markdown, no extra keys:
{
  "intent": "<what user wants>",
  "tool": { "name": "<tool_name>", "args": {} },
  "response": "<1-3 sentences, max 60 words>"
}

IMPORTANT: Omit "tool" entirely when no tool is needed. NEVER return "tool": {} with no name.

Available tools (use only when relevant):
  generate_workout | next_workout | program_status | weekly_program
  workout_history  | adaptive_adjustment | body_metrics | achievements
  streak_info      | recovery_plan       | log_workout

Never invent data. "response" is always required.`;

    const userContent =
      contextBlock + '\n\n' +
      (similar.length ? `RELATED PAST MSGS:\n${similar.join('\n')}\n\n` : '') +
      `ATHLETE: ${message}`;

    const res = await fetchWithRetry(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.4, max_completion_tokens: 400,
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
