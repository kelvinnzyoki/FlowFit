import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

// No axios — uses Node 18+ native fetch (already available on Vercel, no extra dep needed)

const prisma = new PrismaClient();

// Models tried in priority order. First one that works is cached and reused.
// Override with XAI_MODEL env var to pin to a specific model.
const MODEL_PRIORITY = ['grok-3-beta', 'grok-2-latest', 'grok-2-1212', 'grok-beta'];
let _resolvedModel: string | null = process.env.XAI_MODEL || null;

interface WorkoutPreferences {
  goal: string;
  fitnessLevel: string;
  equipment: string[];
  sessionDuration: number;
  trainingDaysPerWeek: number;
  limitations?: string;
  userId: string;
}

export class AIService {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.XAI_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('[AIService] XAI_API_KEY is not set — AI generation will fail');
    }
  }

  // ─── Try each model until one works ──────────────────────────────────────
  private async callXAI(messages: { role: string; content: string }[]): Promise<string> {
    const modelsToTry = _resolvedModel ? [_resolvedModel] : MODEL_PRIORITY;

    for (const model of modelsToTry) {
      logger.info(`[AIService] Trying model: ${model}`);

      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Authorization':  `Bearer ${this.apiKey}`,
          'Content-Type':   'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 1.0,
          max_tokens:  1500,
        }),
        // Native fetch doesn't have built-in timeout — use AbortController
        signal: AbortSignal.timeout(45_000),
      });

      // 404 or 400 with "model not found" means wrong model name — try next
      if (res.status === 400 || res.status === 404) {
        const body = await res.json().catch(() => ({})) as any;
        const detail = body?.error?.message || body?.message || '';
        if (detail.toLowerCase().includes('model') || res.status === 404) {
          logger.warn(`[AIService] Model ${model} not available (${res.status}): ${detail}`);
          continue;  // try next model
        }
        // 400 for other reasons (bad request) — throw immediately
        throw new Error(`xAI rejected the request (400): ${detail}`);
      }

      if (res.status === 401) {
        throw new Error('XAI_API_KEY is invalid or expired. Check your Vercel environment variables.');
      }
      if (res.status === 429) {
        throw new Error('xAI rate limit reached. Please wait a moment and try again.');
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any;
        throw new Error(`xAI API error (${res.status}): ${body?.error?.message || 'Unknown error'}`);
      }

      // Success — cache the working model for subsequent calls
      if (!_resolvedModel) {
        _resolvedModel = model;
        logger.info(`[AIService] Resolved working model: ${model}`);
      }

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('xAI returned an empty response. Please try again.');
      return content;
    }

    throw new Error(
      `None of the xAI models responded. Tried: ${modelsToTry.join(', ')}. ` +
      'Check your XAI_API_KEY and set XAI_MODEL to a valid model name.',
    );
  }

  // ─── System prompt ────────────────────────────────────────────────────────
  private buildSystemPrompt(): string {
    return [
      'You are an expert certified personal trainer specialising in home and gym workouts.',
      'You create safe, progressive, science-based plans tailored to the individual.',
      'You MUST honour the user\'s goal, fitness level, available equipment, session length, and any limitations.',
      'NEVER return the same generic plan — always vary exercises, rep ranges, and focus according to the inputs.',
      'Return ONLY valid JSON. No markdown fences, no explanations, no prose outside the JSON object.',
    ].join(' ');
  }

  // ─── User prompt ─────────────────────────────────────────────────────────
  private buildUserPrompt(
    preferences: WorkoutPreferences,
    availableExercises: { name: string; category: string }[],
  ): string {
    const goalDirectives: Record<string, string> = {
      'muscle gain':    'Hypertrophy focus: 3–5 sets, 8–12 reps, 60–90 s rest. Include compound lifts + isolation work.',
      'fat loss':       'Metabolic conditioning: supersets, circuits, 30–45 s rest. Keep heart rate elevated.',
      'strength':       'Strength focus: 4–6 sets, 3–6 reps, 2–3 min rest. Heavy compound movements.',
      'endurance':      'Endurance focus: 15–20+ reps or timed sets, 20–30 s rest, sustained effort.',
      'general fitness':'Balanced: 3 sets, 10–15 reps, 45–60 s rest. Mix of strength and conditioning.',
    };
    const levelDirectives: Record<string, string> = {
      beginner:     'Beginner-friendly exercises only. Prioritise form cues. Lower volume. Avoid complex movements.',
      intermediate: 'Include some compound movements. Moderate volume and intensity.',
      advanced:     'Compound lifts, unilateral movements, progressive overload. Higher volume is appropriate.',
    };

    const goalHint  = goalDirectives[preferences.goal]          || goalDirectives['general fitness'];
    const levelHint = levelDirectives[preferences.fitnessLevel] || levelDirectives['intermediate'];
    const exerciseCount = Math.max(4, Math.min(8, Math.round(preferences.sessionDuration / 8)));

    const exerciseHints = availableExercises
      .map(ex => `${ex.name} (${ex.category})`)
      .slice(0, 20)
      .join(', ');

    return `
GOAL: ${preferences.goal.toUpperCase()}
FITNESS LEVEL: ${preferences.fitnessLevel.toUpperCase()}
EQUIPMENT AVAILABLE: ${preferences.equipment.join(', ') || 'bodyweight only'}
SESSION DURATION: ${preferences.sessionDuration} minutes
TRAINING DAYS PER WEEK: ${preferences.trainingDaysPerWeek}
LIMITATIONS / NOTES: ${preferences.limitations || 'None'}

TRAINING DIRECTIVE: ${goalHint}
LEVEL DIRECTIVE: ${levelHint}

EXERCISES IN THE USER'S LIBRARY (use these by name where appropriate):
${exerciseHints || 'Use standard bodyweight and dumbbell exercises'}

IMPORTANT RULES:
1. The workout MUST match the goal "${preferences.goal}" — do not default to general fitness.
2. Appropriate for a ${preferences.fitnessLevel} person.
3. Equipment restricted to: ${preferences.equipment.join(', ') || 'bodyweight only'}.
4. Total duration close to ${preferences.sessionDuration} minutes.
5. Respect limitations: ${preferences.limitations || 'none'}.
6. Include exactly ${exerciseCount} exercises.

Return ONLY this JSON (no markdown, no prose outside it):
{
  "workoutName": "specific name reflecting the goal",
  "focus": "e.g. Upper Body Hypertrophy or Full Body Fat Burn",
  "estimatedDurationMinutes": number,
  "warmUp": "specific warm-up for this session type",
  "exercises": [
    {
      "name": "string",
      "sets": number,
      "reps": "e.g. 8-12 or 30 seconds",
      "restSeconds": number,
      "notes": "form tip or modification"
    }
  ],
  "coolDown": "specific cool-down for this session",
  "progressionTips": "how to progress this specific plan"
}`.trim();
  }

  // ─── JSON extraction ─────────────────────────────────────────────────────
  private extractJSON(text: string): object | null {
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const start = stripped.indexOf('{');
    const end   = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      logger.error('[AIService] JSON parse failed', { excerpt: stripped.slice(start, start + 300) });
      return null;
    }
  }

  // ─── Main method ─────────────────────────────────────────────────────────
  async generateWorkoutPlan(preferences: WorkoutPreferences): Promise<object> {
    if (!this.apiKey) {
      throw new Error('XAI_API_KEY is not set. Add it to your Vercel environment variables.');
    }

    const availableExercises = await prisma.exercise.findMany({
      where:   { isActive: true },
      take:    30,
      select:  { id: true, name: true, category: true },
      orderBy: { name: 'asc' },
    });

    const messages = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user',   content: this.buildUserPrompt(preferences, availableExercises) },
    ];

    const rawContent = await this.callXAI(messages);

    const parsed = this.extractJSON(rawContent);
    if (!parsed) {
      throw new Error('Grok returned a response but it was not valid JSON. Please try again.');
    }

    logger.info('[AIService] Plan generated successfully', { goal: preferences.goal });
    return parsed;
  }
}

export const aiService = new AIService();
