import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-4'; // or 'grok-beta' / latest available — check console.x.ai

interface WorkoutPreferences {
  goal: string;           // "muscle gain", "fat loss", "strength", "endurance", "general fitness"
  fitnessLevel: string;   // "beginner", "intermediate", "advanced"
  equipment: string[];    // e.g. ["bodyweight", "dumbbells", "resistance bands", "pull-up bar"]
  sessionDuration: number; // minutes
  trainingDaysPerWeek: number;
  limitations?: string;   // injuries, preferences, etc.
  userId: string;
}

export class AIService {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.XAI_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('XAI_API_KEY not set in environment');
    }
  }

  private buildSystemPrompt(): string {
    return `You are an expert certified personal trainer and strength & conditioning coach with 15+ years of experience specializing in home workouts.

Create safe, effective, progressive workout plans tailored for home training.
Always prioritize proper form, injury prevention, and progressive overload.
Use realistic sets/reps for the user's level and goal.
Include warm-up and cool-down recommendations.`;
  }

  async generateWorkoutPlan(preferences: WorkoutPreferences) {
    // 1. Fetch relevant exercises from your DB (filter by equipment & level)
    const relevantExercises = await prisma.exercise.findMany({
      where: {
        // Add your filtering logic based on equipment, difficulty, target muscles etc.
        OR: preferences.equipment.map(eq => ({ equipment: { contains: eq, mode: 'insensitive' } })),
      },
      take: 30, // limit to keep prompt reasonable
      select: {
        id: true,
        name: true,
        category: true,
        targetMuscles: true,
        difficulty: true,
        equipment: true,
      },
    });

    const userContext = `
User Profile:
- Goal: ${preferences.goal}
- Fitness Level: ${preferences.fitnessLevel}
- Available Equipment: ${preferences.equipment.join(', ') || 'bodyweight only'}
- Session Duration: ${preferences.sessionDuration} minutes
- Training Days per Week: ${preferences.trainingDaysPerWeek}
- Limitations/Injuries: ${preferences.limitations || 'None'}
`;

    const exerciseLibrarySnippet = relevantExercises
      .map(ex => `\( {ex.name} ( \){ex.category}, ${ex.equipment || 'bodyweight'})`)
      .join('\n');

    const fullPrompt = `${userContext}

Available Exercises (use ONLY from this list or close variations):
${exerciseLibrarySnippet || 'Use common bodyweight exercises if library is empty.'}

Generate ONE focused workout session (or a short weekly program if requested).
Output strictly valid JSON only with this structure:

{
  "workoutName": "string",
  "focus": "string (e.g. Push, Pull, Full Body, Legs)",
  "estimatedDurationMinutes": number,
  "warmUp": "string (2-3 sentences)",
  "exercises": [
    {
      "name": "string",
      "sets": number,
      "reps": "string (e.g. 8-12 or 30-45 seconds)",
      "restSeconds": number,
      "notes": "string (form tips, progression, modifications)"
    }
  ],
  "coolDown": "string",
  "progressionTips": "string (how to progress next sessions)"
}

Make it challenging but achievable. Adapt to the user's goal and level.`;

    try {
      const response = await axios.post(
        GROK_API_URL,
        {
          model: MODEL,
          messages: [
            { role: 'system', content: this.buildSystemPrompt() },
            { role: 'user', content: fullPrompt }
          ],
          temperature: 0.7,
          max_tokens: 1200,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 45000, // Grok can be fast
        }
      );

      const aiContent = response.data.choices[0]?.message?.content || '';

      // Extract JSON (Grok sometimes adds extra text)
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      const parsedPlan = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

      if (!parsedPlan) {
        throw new Error('Failed to parse AI response as JSON');
      }

      // Optional: Save generation log for analytics / rate limiting
      await prisma.aiGenerationLog.create({
        data: {
          userId: preferences.userId,
          type: 'workout_plan',
          prompt: fullPrompt.substring(0, 500), // truncate
          response: JSON.stringify(parsedPlan).substring(0, 2000),
        },
      });

      return parsedPlan;

    } catch (error: any) {
      logger.error('Grok API error:', error.response?.data || error.message);
      
      // Fallback to a safe static plan (never break UX)
      return {
        workoutName: "Safe Bodyweight Full Body Session",
        focus: "General Fitness",
        estimatedDurationMinutes: preferences.sessionDuration,
        warmUp: "5 minutes of light cardio + dynamic stretches",
        exercises: [
          { name: "Push-ups", sets: 3, reps: "8-15", restSeconds: 60, notes: "Knee version if needed" },
          { name: "Squats", sets: 3, reps: "12-20", restSeconds: 60, notes: "Bodyweight" },
          { name: "Plank", sets: 3, reps: "30-60 seconds", restSeconds: 45, notes: "" },
        ],
        coolDown: "Static stretching for major muscle groups",
        progressionTips: "Add reps or slow down tempo each week"
      };
    }
  }
}

export const aiService = new AIService();
