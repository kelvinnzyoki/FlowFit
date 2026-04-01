import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

interface WorkoutPreferences {
  goal: string;
  fitnessLevel: string;
  equipment: string[];
  sessionDuration: number;
  trainingDaysPerWeek: number;
  limitations?: string;
  userId: string;
}

// Simple cache
const generationCache = new Map<string, { plan: any; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

export class WorkoutGeneratorService {

  async generateWorkoutPlan(preferences: WorkoutPreferences) {
    const cacheKey = `\( {preferences.userId}- \){preferences.goal}-\( {preferences.fitnessLevel}- \){preferences.sessionDuration}`;

    const cached = generationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return { ...cached.plan, fromCache: true };
    }

    try {
      // Fixed: Removed 'equipment' from select since it doesn't exist in your schema
      const allExercises = await prisma.exercise.findMany({
        where: { isActive: true },
        select: { 
          name: true, 
          category: true 
          // equipment field removed because it doesn't exist in your Exercise model
        }
      });

      const split = this.determineSplit(preferences);
      const plan = this.buildPlan(allExercises, preferences, split);

      generationCache.set(cacheKey, { plan, timestamp: Date.now() });
      if (generationCache.size > 60) {
        generationCache.delete(Array.from(generationCache.keys())[0]);
      }

      return plan;
    } catch (error) {
      logger.error('Workout generator error:', error);
      return this.getFallbackPlan(preferences);
    }
  }

  async suggestProgression(
    userId: string, 
    exerciseName: string, 
    lastSets: number, 
    lastReps: string, 
    lastRPE?: number
  ) {
    const recentLogs = await prisma.workoutLog.findMany({
      where: { 
        userId, 
        // Fixed: Use correct field name from your schema (likely 'exercise' or 'exerciseName')
        exerciseName: exerciseName   // Change to 'exercise' if your model uses that
      },
      orderBy: { createdAt: 'desc' },
      take: 4,
    });

    if (recentLogs.length < 2) {
      return { 
        suggestion: "Great start! Focus on full range of motion and controlled form.", 
        type: "form" 
      };
    }

    const avgReps = recentLogs.reduce((sum, log) => {
      const reps = parseInt(log.reps || '0');
      return sum + (isNaN(reps) ? 0 : reps);
    }, 0) / recentLogs.length;

    if (avgReps >= 12 && lastSets >= 3) {
      return {
        suggestion: `Strong progress! Next session try \( {parseInt(lastReps) + 2}- \){parseInt(lastReps) + 4} reps or add weight.`,
        type: "overload",
        nextTarget: `${lastSets} sets × \( {parseInt(lastReps) + 2}- \){parseInt(lastReps) + 4}`
      };
    }

    if (lastRPE && lastRPE <= 7) {
      return { 
        suggestion: "You had reps left. Push harder next time (aim for RPE 8-9).", 
        type: "intensity" 
      };
    }

    return { 
      suggestion: "Solid work! Keep consistent and gradually increase difficulty.", 
      type: "maintenance" 
    };
  }

  private determineSplit(p: WorkoutPreferences): string {
    const { trainingDaysPerWeek, fitnessLevel } = p;
    if (trainingDaysPerWeek >= 5 && fitnessLevel === 'advanced') return 'ppl';
    if (trainingDaysPerWeek >= 4) return 'upperlower';
    if (p.goal === 'strength' || p.goal === 'muscle gain') return 'pushpull';
    return 'fullbody';
  }

  private buildPlan(exercises: any[], p: WorkoutPreferences, split: string) {
    const rule = this.getRepRule(p.goal, p.fitnessLevel);
    let pool = [...exercises].sort(() => Math.random() - 0.5);

    const selected: any[] = [];

    if (split === 'fullbody') {
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['CORE']));
      selected.push(this.pickByCategory(pool, ['CARDIO', 'HIIT']));
    } else if (split === 'upperlower') {
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['STRENGTH', 'CORE']));
    } else if (split === 'pushpull') {
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['CORE']));
    } else if (split === 'ppl') {
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['STRENGTH', 'CORE']));
    }

    return {
      workoutName: this.generateWorkoutName(p),
      focus: this.getSplitName(split),
      estimatedDurationMinutes: Math.min(p.sessionDuration, 60),
      warmUp: "5-10 minutes light cardio (Jumping Jacks or High Knees) + dynamic stretches",
      exercises: selected.filter(Boolean).map(ex => ({
        name: ex.name,
        sets: rule.sets,
        reps: rule.reps,
        restSeconds: rule.rest,
        notes: this.getExerciseNotes(ex, p)
      })),
      coolDown: "Static stretching: Child's Pose, Downward Dog, Hip Flexor Stretch",
      progressionTips: this.getProgressionTips(p),
      splitType: split
    };
  }

  private getRepRule(goal: string, level: string) {
    const rules = {
      'muscle gain': { sets: level === 'advanced' ? 4 : 3, reps: '8-12', rest: 75 },
      'fat loss':    { sets: 3, reps: '12-20', rest: 45 },
      'strength':    { sets: level === 'advanced' ? 5 : 4, reps: '5-8', rest: 120 },
      'endurance':   { sets: 3, reps: '15-25', rest: 40 },
      'general fitness': { sets: 3, reps: '10-15', rest: 60 }
    };
    return rules[goal as keyof typeof rules] || rules['general fitness'];
  }

  private pickByCategory(pool: any[], categories: string[]) {
    const filtered = pool.filter(ex => 
      categories.some(cat => ex.category === cat)
    );
    if (filtered.length === 0) return null;
    const chosen = filtered[0];
    pool.splice(pool.indexOf(chosen), 1);
    return chosen;
  }

  private generateWorkoutName(p: WorkoutPreferences) {
    const map: Record<string, string> = {
      'muscle gain': 'Hypertrophy Flow',
      'fat loss': 'Metabolic Burn',
      'strength': 'Strength Builder',
      'endurance': 'Endurance Builder',
      'general fitness': 'Total Body Flow'
    };
    return map[p.goal] || 'Custom FlowFit Session';
  }

  private getSplitName(split: string) {
    const map: Record<string, string> = {
      fullbody: 'Full Body',
      upperlower: 'Upper / Lower',
      pushpull: 'Push / Pull',
      ppl: 'Push / Pull / Legs'
    };
    return map[split] || 'Custom Split';
  }

  private getExerciseNotes(ex: any, p: WorkoutPreferences) {
    if (p.limitations?.toLowerCase().includes('wrist')) {
      return 'Modify for wrist comfort (e.g. knee push-ups)';
    }
    return 'Bodyweight';
  }

  private getProgressionTips(p: WorkoutPreferences) {
    return p.fitnessLevel === 'beginner'
      ? "Master form first. Add 1-2 reps when it feels easy."
      : "When you hit the upper rep range comfortably, increase weight or reps.";
  }

  private getFallbackPlan(p: WorkoutPreferences) {
    return {
      workoutName: "Safe Bodyweight Flow",
      focus: "Full Body",
      estimatedDurationMinutes: p.sessionDuration,
      warmUp: "5 min light cardio + dynamic stretches",
      exercises: [
        { name: "Push-ups", sets: 3, reps: "8-12", restSeconds: 60, notes: "Knee version if needed" },
        { name: "Squats", sets: 3, reps: "12-15", restSeconds: 60, notes: "" },
        { name: "Plank", sets: 3, reps: "30-60 seconds", restSeconds: 45, notes: "Core tight" },
      ],
      coolDown: "Static stretching: Child's Pose, Downward Dog",
      progressionTips: "Add reps or slow tempo weekly"
    };
  }
}

export const workoutGenerator = new WorkoutGeneratorService();
