import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';   // ← Changed to default import (most common in your project)

const prisma = new PrismaClient();

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-4';   // Use 'grok-4' or 'grok-4.20-reasoning' if available in your xAI console

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
      logger.warn('XAI_API_KEY is not set in environment variables');
    }
  }

  private buildSystemPrompt(): string {
    return `You are an expert certified personal trainer specializing in home workouts. 
Create safe, effective, progressive plans. Prioritize form and injury prevention.`;
  }

  async generateWorkoutPlan(preferences: WorkoutPreferences) {
    // Simplified query - removed fields that don't exist in your Exercise model
    const relevantExercises = await prisma.exercise.findMany({
      where: {
        isActive: true,                    // safe filter
        // Remove equipment OR block for now if it causes issues - you can add later
      },
      take: 25,
      select: {
        id: true,
        name: true,
        category: true,
        // Remove targetMuscles and equipment if they don't exist in schema
      },
    });

    const userContext = `
User Profile:
- Goal: ${preferences.goal}
- Fitness Level: ${preferences.fitnessLevel}
- Available Equipment: ${preferences.equipment.join(', ') || 'bodyweight only'}
- Session Duration: ${preferences.sessionDuration} minutes
- Training Days per Week: ${preferences.trainingDaysPerWeek}
- Limitations: ${preferences.limitations || 'None'}
`;

    const exerciseList = relevantExercises
      .map(ex => ex.name)
      .join('\n');

    const fullPrompt = `${userContext}

Use only realistic home exercises (bodyweight, dumbbells, bands, etc.).
Generate ONE good workout session.

Return ONLY valid JSON with this exact structure:
{
  "workoutName": "string",
  "focus": "string",
  "estimatedDurationMinutes": number,
  "warmUp": "string",
  "exercises": [
    { "name": "string", "sets": number, "reps": "string", "restSeconds": number, "notes": "string" }
  ],
  "coolDown": "string",
  "progressionTips": "string"
}`;

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
          max_tokens: 1000,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 40000,
        }
      );

      const aiContent = response.data.choices?.[0]?.message?.content || '';
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      const parsedPlan = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

      if (!parsedPlan) throw new Error('Invalid JSON from Grok');

      // Removed aiGenerationLog because the model doesn't exist yet
      // You can add this table later if you want logging

      return parsedPlan;

    } catch (error: any) {
      logger.error('Grok AI error:', error.response?.data || error.message);

      // Safe fallback plan
      return {
        workoutName: "Bodyweight Full Body Workout",
        focus: "General Fitness",
        estimatedDurationMinutes: preferences.sessionDuration,
        warmUp: "5 minutes light cardio + arm circles and leg swings",
        exercises: [
          { name: "Push-ups", sets: 3, reps: "8-15", restSeconds: 60, notes: "Knee version if needed" },
          { name: "Squats", sets: 3, reps: "12-20", restSeconds: 60, notes: "Bodyweight" },
          { name: "Plank", sets: 3, reps: "30-60 seconds", restSeconds: 45, notes: "Keep core tight" },
        ],
        coolDown: "Static stretching for chest, legs, and shoulders",
        progressionTips: "Add 1-2 reps or slow down the movement each week"
      };
    }
  }
}

export const aiService = new AIService();
