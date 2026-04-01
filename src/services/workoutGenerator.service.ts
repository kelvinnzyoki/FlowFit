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

// Simple cache for variety
const generationCache = new Map<string, { plan: any; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export class WorkoutGeneratorService {

  async generateWorkoutPlan(preferences: WorkoutPreferences) {
    const cacheKey = `\( {preferences.userId}- \){preferences.goal}-\( {preferences.fitnessLevel}- \){preferences.sessionDuration}`;

    const cached = generationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return { ...cached.plan, fromCache: true };
    }

    try {
      const allExercises = await prisma.exercise.findMany({
        where: { isActive: true },
        select: { name: true, category: true }
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
    exerciseId: string,
    lastSets: number,
    lastReps: string,
    lastRPE?: number
  ) {
    try {
      const recentLogs = await prisma.workoutLog.findMany({
        where: { 
          userId, 
          exerciseId: exerciseId   // Change to 'exerciseName' if your model uses that
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
        const repsStr = String(log.reps || "0");
        const repsNum = parseInt(repsStr, 10);
        return sum + (isNaN(repsNum) ? 0 : repsNum);
      }, 0) / recentLogs.length;

      const lastRepsNum = parseInt(String(lastReps), 10) || 8;

      if (avgReps >= 12 && lastSets >= 3) {
        return {
          suggestion: `Strong progress! Next session try \( {lastRepsNum + 2}- \){lastRepsNum + 4} reps or add weight.`,
          type: "overload",
          nextTarget: `${lastSets} sets × \( {lastRepsNum + 2}- \){lastRepsNum + 4}`
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
    } catch (error) {
      logger.error('suggestProgression error:', error);
      return { suggestion: "Keep up the great work!", type: "maintenance" };
    }
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
    } else {
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['STRENGTH']));
      selected.push(this.pickByCategory(pool, ['CORE']));
    }

    return {
      workoutName: this.generateWorkoutName(p),
      focus: this.getSplitName(split),
      estimatedDurationMinutes: Math.min(p.sessionDuration, 60),
      warmUp: "5-10 minutes light cardio (Jumping Jacks or High Knees) + dynamic stretches",
      exercises: selected.filter(Boolean).map((ex: any) => ({
        name: ex.name,
        sets: rule.sets,
        reps: rule.reps,
        restSeconds: rule.rest,
        notes: p.limitations?.toLowerCase().includes('wrist') ? 'Modify for wrist comfort' : 'Bodyweight'
      })),
      coolDown: "Static stretching: Child's Pose, Downward Dog",
      progressionTips: p.fitnessLevel === 'beginner' 
        ? "Focus on form first." 
        : "Increase reps or weight when it feels easy.",
      splitType: split
    };
  }

  private getRepRule(goal: string, level: string) {
    const rules: any = {
      'muscle gain': { sets: level === 'advanced' ? 4 : 3, reps: '8-12', rest: 75 },
      'fat loss':    { sets: 3, reps: '12-20', rest: 45 },
      'strength':    { sets: level === 'advanced' ? 5 : 4, reps: '5-8', rest: 120 },
      'endurance':   { sets: 3, reps: '15-25', rest: 40 },
      'general fitness': { sets: 3, reps: '10-15', rest: 60 }
    };
    return rules[goal] || rules['general fitness'];
  }

  private pickByCategory(pool: any[], categories: string[]) {
    const filtered = pool.filter((ex: any) => categories.includes(ex.category));
    if (filtered.length === 0) return null;
    const chosen = filtered[0];
    pool.splice(pool.indexOf(chosen), 1);
    return chosen;
  }

  private generateWorkoutName(p: WorkoutPreferences) {
    const map: any = {
      'muscle gain': 'Hypertrophy Flow',
      'fat loss': 'Metabolic Burn',
      'strength': 'Strength Builder',
      'endurance': 'Endurance Builder',
      'general fitness': 'Total Body Flow'
    };
    return map[p.goal] || 'Custom FlowFit Session';
  }

  private getSplitName(split: string) {
    const map: any = {
      fullbody: 'Full Body',
      upperlower: 'Upper / Lower',
      pushpull: 'Push / Pull',
      ppl: 'Push / Pull / Legs'
    };
    return map[split] || 'Custom Split';
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
      coolDown: "Static stretching",
      progressionTips: "Add reps when it feels easy."
    };
  }
}

export const workoutGenerator = new WorkoutGeneratorService();
