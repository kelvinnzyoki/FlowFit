import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

// Read model from env so you can swap it without redeploying.
// xAI current production models: grok-3, grok-3-mini, grok-3-latest
// Default to grok-3 — override with XAI_MODEL=grok-3-mini for cheaper calls.
const MODEL = process.env.XAI_MODEL || 'grok-3';

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
    // Map goal → concrete training directives so Grok produces varied output
    const goalDirectives: Record<string, string> = {
      'muscle gain':    'Emphasise hypertrophy: 3–5 sets, 8–12 reps, 60–90 s rest. Include compound lifts + isolation work.',
      'fat loss':       'Emphasise metabolic conditioning: supersets, circuits, shorter rest (30–45 s). Keep heart rate elevated.',
      'strength':       'Emphasise heavy compound movements: 4–6 sets, 3–6 reps, 2–3 min rest. Focus on progressive overload.',
      'endurance':      'Emphasise high-rep / timed sets (15–20+ reps or 30–60 s), minimal rest (20–30 s), sustained effort.',
      'general fitness':'Balanced mix of strength and conditioning. 3 sets, 10–15 reps, 45–60 s rest.',
    };
    const levelDirectives: Record<string, string> = {
      beginner:     'Choose beginner-friendly exercises. Prioritise form cues. Avoid complex movements. Lower volume.',
      intermediate: 'Include some compound movements. Moderate volume and intensity.',
      advanced:     'Use compound lifts, unilateral movements, and progressive overload. Higher volume is appropriate.',
    };

    const goalHint  = goalDirectives[preferences.goal]       || goalDirectives['general fitness'];
    const levelHint = levelDirectives[preferences.fitnessLevel] || levelDirectives['intermediate'];

    // Only pass relevant exercises (filtered by equipment suitability) to keep the prompt focused
    const equipmentSet = new Set(preferences.equipment.map(e => e.toLowerCase()));
    const hasWeights   = equipmentSet.has('dumbbells') || equipmentSet.has('barbell') || equipmentSet.has('kettlebell');
    const hasBands     = equipmentSet.has('resistance bands');
    const hasPullBar   = equipmentSet.has('pull-up bar');

    const exerciseHints = availableExercises
      .filter(ex => {
        // Always include bodyweight exercises
        const isBW = ['STRENGTH','CARDIO','CORE','HIIT','FLEXIBILITY'].includes(ex.category.toUpperCase());
        return isBW;
      })
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
2. The workout MUST be appropriate for a ${preferences.fitnessLevel} person.
3. Equipment is restricted to: ${preferences.equipment.join(', ') || 'bodyweight only'}.
4. Duration must be close to ${preferences.sessionDuration} minutes total.
5. Respect limitations: ${preferences.limitations || 'none'}.
6. Include ${Math.max(4, Math.min(8, Math.round(preferences.sessionDuration / 8)))} exercises.

Return ONLY this JSON (no markdown, no prose):
{
  "workoutName": "string — specific name reflecting the goal and focus",
  "focus": "string — e.g. 'Upper Body Hypertrophy' or 'Full Body Fat Burn'",
  "estimatedDurationMinutes": number,
  "warmUp": "string — specific warm-up for this session type",
  "exercises": [
    {
      "name": "string",
      "sets": number,
      "reps": "string — e.g. '8-12' or '30 seconds'",
      "restSeconds": number,
      "notes": "string — form tip or modification"
    }
  ],
  "coolDown": "string — specific cool-down for this session",
  "progressionTips": "string — how to progress THIS specific plan"
}`.trim();
  }

  // ─── JSON extraction ─────────────────────────────────────────────────────
  private extractJSON(text: string): object | null {
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    // Find the outermost JSON object
    const start = stripped.indexOf('{');
    const end   = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch (parseErr) {
      logger.error('[AIService] JSON parse failed:', { excerpt: stripped.slice(start, start + 200) });
      return null;
    }
  }

  // ─── Main generation method ───────────────────────────────────────────────
  async generateWorkoutPlan(preferences: WorkoutPreferences): Promise<object> {
    if (!this.apiKey) {
      throw new Error('XAI_API_KEY is not configured on the server.');
    }

    // Fetch relevant exercises from the DB to enrich the prompt
    const availableExercises = await prisma.exercise.findMany({
      where:  { isActive: true },
      take:   30,
      select: { id: true, name: true, category: true },
      orderBy: { name: 'asc' },
    });

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt   = this.buildUserPrompt(preferences, availableExercises);

    logger.info('[AIService] Calling xAI', { model: MODEL, goal: preferences.goal, level: preferences.fitnessLevel });

    let rawContent = '';
    try {
      const response = await axios.post(
        'https://api.x.ai/v1/chat/completions',
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
          temperature: 1.0,    // Higher = more varied output per request
          max_tokens:  1500,
        },
        {
          headers: {
            Authorization:  `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 45000,  // 45 s — Grok can be slow on first token
        },
      );

      rawContent = response.data.choices?.[0]?.message?.content || '';
      logger.info('[AIService] Raw response received', { chars: rawContent.length });

    } catch (apiErr: any) {
      const status  = apiErr.response?.status;
      const detail  = apiErr.response?.data?.error?.message || apiErr.message;
      logger.error('[AIService] xAI API call failed', { status, detail });

      // Throw a descriptive error — do NOT return a silent fallback.
      // The route handler catches this and returns HTTP 500 to the frontend,
      // which shows the real error message instead of a fake identical plan.
      if (status === 401) throw new Error('Invalid XAI_API_KEY — check your environment variables.');
      if (status === 400) throw new Error(`xAI rejected the request (400): ${detail} — check XAI_MODEL env var (current: ${MODEL})`);
      if (status === 429) throw new Error('xAI rate limit reached. Please wait a moment and try again.');
      throw new Error(`xAI API error (${status ?? 'network'}): ${detail}`);
    }

    // Parse the JSON response
    const parsed = this.extractJSON(rawContent);
    if (!parsed) {
      logger.error('[AIService] Could not extract JSON from response', { rawContent: rawContent.slice(0, 500) });
      throw new Error('Grok returned a response but it was not valid JSON. Please try again.');
    }

    logger.info('[AIService] Plan generated successfully', { goal: preferences.goal });
    return parsed;
  }
}

export const aiService = new AIService();
