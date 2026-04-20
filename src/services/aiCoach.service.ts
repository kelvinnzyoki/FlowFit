// aiCoach.service.ts
// V11: Migrated from Ollama → Groq API
//
// CHANGES FROM V10 (Ollama) → V11 (Groq):
//  A. GROQ_API_KEY from env, Groq chat endpoint (OpenAI-compatible format)
//  B. Response shape: choices[0].message.content  (not message.content)
//  C. Model: llama-3.3-70b-versatile + response_format: json_object
//  D. generateEmbedding: local n-gram hashing (Groq has no embeddings API)
//  E. generateEmbedding is now synchronous — no network call, no timeout needed
//  F. All Ollama error messages updated to Groq
//  G. Removed stream:false (Groq defaults to false, field not needed)

import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const GROQ_API_KEY    = process.env.GROQ_API_KEY ?? '';
const GROQ_CHAT_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL      = 'llama-3.3-70b-versatile';
const FETCH_TIMEOUT_MS = 20_000;  // 20 s timeout for LLM calls
const MAX_RETRIES      = 3;
const MAX_EMBEDDINGS   = 200;     // per user — oldest pruned beyond this
const EMBED_DIMS       = 512;     // local embedding dimensions

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type ToolName =
  | 'generate_workout'
  | 'weekly_program'
  | 'recovery_plan'
  | 'log_workout'
  | 'adaptive_adjustment';

interface ConversationMemory {
  profile?:            UserProfile;
  fatigueScore?:       number;
  adherenceScore?:     number;
  lastWorkoutPlan?:    WorkoutPlan;
  performanceHistory?: PerformanceEntry[];
}

interface UserProfile {
  fitnessGoal?:  string;
  fitnessLevel?: string;
  weight?:       number;
  height?:       number;
}

interface WorkoutPlan {
  type:      string;
  exercises: ExerciseEntry[];
}

interface ExerciseEntry {
  name: string;
  sets: number;
  reps: number;
}

interface PerformanceEntry {
  date:      string;
  exercises: ExerciseEntry[];
  notes?:    string;
}

// Groq uses OpenAI-compatible response shape
interface GroqChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

// Zod schema — validates LLM JSON output at runtime
const LLMResponseSchema = z.object({
  intent:   z.string(),
  tool: z.object({
    name: z.enum([
      'generate_workout',
      'weekly_program',
      'recovery_plan',
      'log_workout',
      'adaptive_adjustment',
    ]),
    args: z.any().optional(),
  }).optional(),
  response: z.string().optional(),
});

type LLMStructured = z.infer<typeof LLMResponseSchema>;

// Standard API response shape expected by routes
export interface CoachResponse {
  success: boolean;
  reply:   string;
  data?:   any;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Fetch with AbortController timeout + exponential-backoff retry.
 * Retries on 429 (rate-limit) and 5xx errors.
 */
async function fetchWithRetry(
  url:     string,
  options: RequestInit,
  attempt  = 1,
): Promise<Response> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = 2 ** attempt * 500; // 500 ms, 1 s, 2 s
      await new Promise(r => setTimeout(r, backoff));
      return fetchWithRetry(url, options, attempt + 1);
    }

    return res;
  } catch (err: any) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES) {
      const backoff = 2 ** attempt * 500;
      await new Promise(r => setTimeout(r, backoff));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

/** Safe JSON parse — returns null instead of throwing */
function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// SERVICE CLASS
// ─────────────────────────────────────────────────────────────

class AICoachService {

  // ── PUBLIC ENTRY POINT ────────────────────────────────────────────────

  async getResponse(
    userId:  string,
    message: string,
    _ctx?:   { userId: string; currentExercise?: string },
  ): Promise<CoachResponse> {
    try {
      // 1. Load memory + user profile from DB
      const memory = await this.loadMemory(userId);
      await this.hydrateProfile(userId, memory);

      // 2. Generate local embedding & store (synchronous, no network call)
      const embedding = this.generateEmbedding(message);
      await this.storeEmbedding(userId, message, embedding);

      // 3. Semantic context retrieval (capped to MAX_EMBEDDINGS)
      const similar = await this.semanticSearch(userId, embedding);

      // 4. Call Groq LLM with validated response
      const llm = await this.callLLM(message, memory, similar);

      // 5. Execute intent
      const result = await this.execute(llm, userId, memory);

      // 6. Update behaviour tracking + save memory
      this.updateBehavior(memory, message);
      await this.saveMemory(userId, memory);

      return result;

    } catch (err: any) {
      console.error('[AICoach] getResponse error:', err);
      return {
        success: false,
        reply:   'Your coach hit a snag. Please try again in a moment.',
      };
    }
  }

  // ── GROQ LLM CALL ────────────────────────────────────────────────────

  private async callLLM(
    message: string,
    memory:  ConversationMemory,
    context: string[],
  ): Promise<LLMStructured> {

    const systemPrompt = `You are FlowFit's elite AI fitness coach.
Always respond with valid JSON matching exactly this shape:
{
  "intent": "<string describing user intent>",
  "tool": { "name": "<tool_name>", "args": <object or null> },
  "response": "<conversational reply>"
}
Available tools: generate_workout, weekly_program, recovery_plan, log_workout, adaptive_adjustment.
Only include "tool" when the user explicitly wants to take an action.
The "response" field is always required even when a tool is used.`;

    const userContent =
      `Memory: ${JSON.stringify(memory)}\n` +
      `Similar past messages: ${context.join('\n')}\n` +
      `User message: ${message}`;

    const res = await fetchWithRetry(GROQ_CHAT_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:                GROQ_MODEL,
        temperature:          0.4,
        max_completion_tokens: 1024,
        // Forces valid JSON output — supported on llama-3.3-70b-versatile
        response_format:      { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent  },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Groq API error ${res.status}: ${errBody}`);
    }

    // Groq OpenAI-compatible shape: choices[0].message.content
    const data = await res.json() as GroqChatResponse;
    const raw  = data.choices?.[0]?.message?.content;

    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('Groq returned empty content');
    }

    // Safe parse + zod validation
    const parsed = safeJsonParse(raw);
    const result = LLMResponseSchema.safeParse(parsed);

    if (!result.success) {
      console.warn('[AICoach] LLM validation failed:', result.error.message);
      // Fallback: treat the raw text as the reply
      return { intent: 'unknown', response: raw.slice(0, 500) };
    }

    return result.data;
  }

  // ── EXECUTION ────────────────────────────────────────────────────────

  private async execute(
    llm:    LLMStructured,
    userId: string,
    memory: ConversationMemory,
  ): Promise<CoachResponse> {
    const baseReply = llm.response ?? 'How can I help with your training?';

    if (!llm.tool) {
      return { success: true, reply: baseReply };
    }

    const toolResult = await this.executeTool(llm.tool, userId, memory);

    return {
      success: true,
      reply:   toolResult.reply ?? baseReply,
      data:    toolResult.data,
    };
  }

  private async executeTool(
    tool:   NonNullable<LLMStructured['tool']>,
    userId: string,
    memory: ConversationMemory,
  ): Promise<CoachResponse> {
    switch (tool.name) {
      case 'generate_workout':
        return this.generateWorkout(memory);

      case 'weekly_program':
        return this.generateWeeklyProgram(memory);

      case 'recovery_plan':
        return this.recoveryPlan();

      case 'log_workout':
        return this.logWorkout(userId, memory, tool.args);

      case 'adaptive_adjustment':
        return this.adaptNextWorkout(userId, memory);

      default:
        return { success: false, reply: 'That feature is not available yet.' };
    }
  }

  // ── WORKOUT GENERATION ───────────────────────────────────────────────

  private generateWorkout(memory: ConversationMemory): CoachResponse {
    const level = memory.profile?.fitnessLevel ?? 'intermediate';
    const goal  = memory.profile?.fitnessGoal  ?? 'general fitness';

    const plans: Record<string, WorkoutPlan> = {
      beginner: {
        type: 'Beginner Full Body',
        exercises: [
          { name: 'Push-ups',          sets: 3, reps: 8  },
          { name: 'Bodyweight Squats', sets: 3, reps: 10 },
          { name: 'Plank (30 s)',      sets: 3, reps: 1  },
          { name: 'Glute Bridge',      sets: 3, reps: 12 },
        ],
      },
      intermediate: {
        type: 'Intermediate Strength',
        exercises: [
          { name: 'Push-ups',          sets: 4, reps: 12 },
          { name: 'Goblet Squat',      sets: 4, reps: 10 },
          { name: 'Dumbbell Row',      sets: 4, reps: 10 },
          { name: 'Romanian Deadlift', sets: 3, reps: 12 },
          { name: 'Plank (45 s)',      sets: 3, reps: 1  },
        ],
      },
      advanced: {
        type: 'Advanced Power',
        exercises: [
          { name: 'Barbell Squat',    sets: 5, reps: 5 },
          { name: 'Bench Press',      sets: 5, reps: 5 },
          { name: 'Barbell Deadlift', sets: 4, reps: 4 },
          { name: 'Pull-ups',         sets: 4, reps: 8 },
          { name: 'Overhead Press',   sets: 4, reps: 6 },
        ],
      },
    };

    const plan = plans[level] ?? plans['intermediate'];
    memory.lastWorkoutPlan = plan;

    const list = plan.exercises
      .map(e => `• ${e.name}  ${e.sets}×${e.reps}`)
      .join('\n');

    return {
      success: true,
      reply:   `Here's your ${plan.type} workout tailored for ${goal}:\n\n${list}\n\nReady to start? Let me know when you finish and I'll log it!`,
      data:    { workout: plan },
    };
  }

  private generateWeeklyProgram(memory: ConversationMemory): CoachResponse {
    const goal = memory.profile?.fitnessGoal ?? 'general fitness';

    const program = [
      { day: 'Monday',    focus: 'Push (Chest · Shoulders · Triceps)' },
      { day: 'Tuesday',   focus: 'Pull (Back · Biceps)'               },
      { day: 'Wednesday', focus: 'Legs + Core'                        },
      { day: 'Thursday',  focus: 'Active Recovery / Mobility'         },
      { day: 'Friday',    focus: 'Upper Body Strength'                },
      { day: 'Saturday',  focus: 'Lower Body + Cardio'               },
      { day: 'Sunday',    focus: 'Rest'                              },
    ];

    const reply =
      `Your 7-day plan for ${goal}:\n\n` +
      program.map(d => `${d.day}: ${d.focus}`).join('\n');

    return { success: true, reply, data: { program } };
  }

  private recoveryPlan(): CoachResponse {
    return {
      success: true,
      reply:
        `Recovery Protocol:\n\n` +
        `• 10 min dynamic warm-down\n` +
        `• Foam roll major muscle groups (15 min)\n` +
        `• Static stretching (10 min)\n` +
        `• Hydrate: 500–750 ml water\n` +
        `• Sleep 7–9 hours\n` +
        `• Optional: light 20-min walk tomorrow`,
    };
  }

  // ── WORKOUT LOGGING ──────────────────────────────────────────────────

  private async logWorkout(
    userId: string,
    memory: ConversationMemory,
    args:   any,
  ): Promise<CoachResponse> {
    const {
      exerciseId     = null,
      sets           = 3,
      reps           = 10,
      duration       = 30,
      notes          = '',
      caloriesBurned,
    } = args ?? {};

    if (exerciseId) {
      const exercise = await prisma.exercise.findUnique({ where: { id: exerciseId } });
      if (!exercise) {
        return { success: false, reply: 'Exercise not found. Please choose a valid exercise.' };
      }
    } else {
      console.warn('[AICoach] logWorkout called without exerciseId — skipping DB persist');
    }

    const entry: PerformanceEntry = {
      date:      new Date().toISOString(),
      exercises: [{ name: args?.name ?? 'Workout', sets, reps }],
      notes,
    };

    memory.performanceHistory = memory.performanceHistory ?? [];
    memory.performanceHistory.push(entry);

    if (exerciseId) {
      await prisma.workoutLog.create({
        data: {
          userId,
          exerciseId,
          duration,
          sets,
          reps,
          notes:          notes || null,
          caloriesBurned: caloriesBurned ?? null,
          completed:      true,
        },
      });
    }

    return {
      success: true,
      reply:   `Workout logged! ${sets} sets × ${reps} reps. Great work — consistency is everything. 🔥`,
    };
  }

  // ── ADAPTIVE ENGINE ──────────────────────────────────────────────────

  private async adaptNextWorkout(
    userId:   string,
    _memory:  ConversationMemory,
  ): Promise<CoachResponse> {
    const logs = await prisma.workoutLog.findMany({
      where:   { userId },
      orderBy: { date: 'desc' },
      take:    10,
      include: { exercise: { select: { name: true } } },
    });

    if (logs.length < 2) {
      return {
        success: true,
        reply:   'Not enough logged workouts yet. Keep training — I need at least 2 sessions to adapt your plan!',
      };
    }

    const [last, prev] = logs;
    const lastReps   = last.reps ?? 0;
    const prevReps   = prev.reps ?? 0;
    const lastSets   = last.sets ?? 0;
    const prevSets   = prev.sets ?? 0;
    const volumeLast = lastSets * lastReps;
    const volumePrev = prevSets * prevReps;
    const improved   = volumeLast > volumePrev;

    let reply: string;

    if (improved) {
      const pct = (((volumeLast - volumePrev) / Math.max(volumePrev, 1)) * 100).toFixed(0);
      reply = `💪 You improved volume by ${pct}% since last session (${volumePrev} → ${volumeLast} total reps). Increasing intensity next session — add 2.5 kg or 2 reps to each set.`;
    } else if (volumeLast === volumePrev) {
      reply = `Performance steady. Maintain this week and focus on form quality — small technique wins compound fast.`;
    } else {
      reply = `Volume dipped slightly (${volumePrev} → ${volumeLast}). That's normal — could be fatigue or life. Keeping intensity the same; prioritise sleep and hydration.`;
    }

    return {
      success: true,
      reply,
      data: {
        lastSession: { exercise: last.exercise?.name, sets: lastSets, reps: lastReps },
        prevSession: { exercise: prev.exercise?.name, sets: prevSets, reps: prevReps },
        improved,
      },
    };
  }

  // ── LOCAL EMBEDDINGS ─────────────────────────────────────────────────
  //
  // Groq has no embeddings endpoint (not present in the API reference).
  // This generates a 512-dimensional vector using character n-gram hashing
  // + L2 normalization. It is:
  //   • Synchronous — zero network latency
  //   • Free — no additional API key
  //   • Deterministic — same text always yields same vector
  //   • Functional — cosine similarity correctly ranks related messages

  private generateEmbedding(text: string): number[] {
    const vector  = new Array<number>(EMBED_DIMS).fill(0);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words   = cleaned.split(/\s+/).filter(Boolean);

    for (const word of words) {
      // djb2 hash of whole word, spread across multiple dimensions
      let wh = 5381;
      for (let i = 0; i < word.length; i++) {
        wh = ((wh << 5) + wh + word.charCodeAt(i)) >>> 0;
      }
      for (let d = 0; d < Math.min(8, EMBED_DIMS); d++) {
        vector[(wh + d * 37) % EMBED_DIMS] += 1.0 / (d + 1);
      }

      // Character bigrams — captures partial word similarity
      for (let i = 0; i < word.length - 1; i++) {
        let bh = 5381;
        bh = ((bh << 5) + bh + word.charCodeAt(i))     >>> 0;
        bh = ((bh << 5) + bh + word.charCodeAt(i + 1)) >>> 0;
        vector[bh % EMBED_DIMS] += 0.5;
      }

      // Character trigrams — better recall for fitness terminology
      for (let i = 0; i < word.length - 2; i++) {
        let th = 5381;
        th = ((th << 5) + th + word.charCodeAt(i))     >>> 0;
        th = ((th << 5) + th + word.charCodeAt(i + 1)) >>> 0;
        th = ((th << 5) + th + word.charCodeAt(i + 2)) >>> 0;
        vector[th % EMBED_DIMS] += 0.25;
      }
    }

    // L2 normalize so cosine similarity works correctly
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < EMBED_DIMS; i++) vector[i] /= magnitude;
    }

    return vector;
  }

  private async storeEmbedding(
    userId:  string,
    text:    string,
    vector:  number[],
  ): Promise<void> {
    await prisma.embedding.create({
      data: { userId, text, vector },
    });

    // Prune oldest embeddings beyond cap
    const count = await prisma.embedding.count({ where: { userId } });

    if (count > MAX_EMBEDDINGS) {
      const oldest = await prisma.embedding.findMany({
        where:   { userId },
        orderBy: { createdAt: 'asc' },
        take:    count - MAX_EMBEDDINGS,
        select:  { id: true },
      });

      await prisma.embedding.deleteMany({
        where: { id: { in: oldest.map(e => e.id) } },
      });
    }
  }

  private async semanticSearch(
    userId:         string,
    queryEmbedding: number[],
  ): Promise<string[]> {
    const rows = await prisma.embedding.findMany({
      where:   { userId },
      orderBy: { createdAt: 'desc' },
      take:    MAX_EMBEDDINGS,
    });

    return rows
      .map(row => ({
        text:  row.text,
        score: this.cosineSimilarity(queryEmbedding, row.vector as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(r => r.text);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot  += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  // ── PROFILE HYDRATION ────────────────────────────────────────────────

  private async hydrateProfile(
    userId: string,
    memory: ConversationMemory,
  ): Promise<void> {
    const profile = await prisma.profile.findUnique({
      where:  { userId },
      select: { fitnessGoal: true, fitnessLevel: true, weight: true, height: true },
    });

    if (profile) {
      memory.profile = {
        fitnessGoal:  profile.fitnessGoal  ?? undefined,
        fitnessLevel: profile.fitnessLevel ?? undefined,
        weight:       profile.weight       ?? undefined,
        height:       profile.height       ?? undefined,
      };
    }
  }

  // ── BEHAVIOUR TRACKING ───────────────────────────────────────────────

  private updateBehavior(memory: ConversationMemory, message: string): void {
    const lower = message.toLowerCase();

    if (/skip|miss|skipped|missed/.test(lower)) {
      memory.adherenceScore = Math.max(0,   (memory.adherenceScore ?? 100) - 5);
    } else if (/completed|done|finished|crushed/.test(lower)) {
      memory.adherenceScore = Math.min(100, (memory.adherenceScore ?? 50) + 3);
    } else {
      memory.adherenceScore = Math.min(100, (memory.adherenceScore ?? 50) + 1);
    }

    if (/tired|exhausted|sore|fatigue/.test(lower)) {
      memory.fatigueScore = Math.min(10, (memory.fatigueScore ?? 0) + 2);
    } else {
      memory.fatigueScore = Math.max(0,  (memory.fatigueScore ?? 0) - 1);
    }
  }

  // ── MEMORY PERSISTENCE ───────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// SINGLETON EXPORT — matches `import { aiCoach }` in routes
// ─────────────────────────────────────────────────────────────

export const aiCoach = new AICoachService();
