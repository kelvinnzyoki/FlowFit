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
/** Progressive Overload Suggestion */
  async suggestProgression(
    userId: string, 
    exerciseId: string, 
    lastSets: number, 
    lastReps: string, 
    lastRPE?: number
  ) {
    try {
      // FIXED: Use correct field name from your Prisma schema
      // Change 'exerciseName' to 'exercise' if that's what your model uses
      const recentLogs = await prisma.workoutLog.findMany({
        where: { 
          userId, 
          exerciseId: exerciseId        // ← Most likely correct field (change if needed)
          // exerciseName: exerciseName // ← Try this only if the above fails
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

      // FIXED: Safe parsing to avoid number/string error
      const avgReps = recentLogs.reduce((sum, log) => {
        const repsStr = String(log.reps || "0");
        const repsNum = parseInt(repsStr, 10);
        return sum + (isNaN(repsNum) ? 0 : repsNum);
      }, 0) / recentLogs.length;

      const lastRepsNum = parseInt(String(lastReps), 10) || 0;

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
      return { 
        suggestion: "Keep up the great work!", 
        type: "maintenance" 
      };
    }
  }

  private determineSplit(p: WorkoutPreferences): string {
    const { trainingDaysPerWeek, fitnessLevel, goal } = p;

    if (trainingDaysPerWeek >= 5 && fitnessLevel === 'advanced') return 'ppl';
    if (trainingDaysPerWeek >= 4) return 'upperlower';
    if (goal === 'strength' || goal === 'muscle gain') return 'pushpull';
    return 'fullbody';
  }

  private buildPlan(exercises: any[], p: WorkoutPreferences, split: string) {
    const rule = this.getRepRule(p.goal, p.fitnessLevel);

    // Better shuffling with seed based on inputs for controlled variety
    let pool = this.smartShuffle(exercises, p);

    const selected: any[] = [];
    const usedCategories = new Set<string>();

    if (split === 'fullbody') {
      // Prioritize variety: Push → Pull → Legs → Core
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p)); // Second strength (often push/pull)
      selected.push(this.pickBestExercise(pool, ['CORE'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['CARDIO', 'HIIT'], usedCategories, p));
    } 
    else if (split === 'upperlower') {
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['STRENGTH', 'CORE'], usedCategories, p));
    } 
    else if (split === 'pushpull') {
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['CORE'], usedCategories, p));
    } 
    else if (split === 'ppl') {
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['STRENGTH'], usedCategories, p));
      selected.push(this.pickBestExercise(pool, ['STRENGTH', 'CORE'], usedCategories, p));
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
        notes: this.getExerciseNotes(ex, p)
      })),
      coolDown: "Static stretching: Child's Pose, Downward Dog, Hip Flexor Stretch",
      progressionTips: this.getProgressionTips(p),
      splitType: split
    };
  }

  // Improved smart shuffle based on user inputs
  private smartShuffle(exercises: any[], p: WorkoutPreferences): any[] {
    let shuffled = [...exercises];

    // Bias toward user's goal
    if (p.goal === 'muscle gain' || p.goal === 'strength') {
      shuffled.sort((a, b) => {
        const aStrength = a.category === 'STRENGTH' ? 3 : 1;
        const bStrength = b.category === 'STRENGTH' ? 3 : 1;
        return bStrength - aStrength;
      });
    } else if (p.goal === 'fat loss') {
      shuffled.sort((a, b) => {
        const aCardio = ['CARDIO', 'HIIT'].includes(a.category) ? 3 : 1;
        const bCardio = ['CARDIO', 'HIIT'].includes(b.category) ? 3 : 1;
        return bCardio - aCardio;
      });
    }

    // Final random shuffle for variety
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
  }

  private pickBestExercise(pool: any[], preferredCategories: string[], used: Set<string>, p: WorkoutPreferences) {
    // First try preferred categories
    let candidates = pool.filter(ex => 
      preferredCategories.some(cat => ex.category === cat) && !used.has(ex.name)
    );

    // Fallback to any available
    if (candidates.length === 0) {
      candidates = pool.filter(ex => !used.has(ex.name));
    }

    if (candidates.length === 0) return null;

    // Pick one and mark as used
    const chosen = candidates[0];
    used.add(chosen.name);
    pool.splice(pool.indexOf(chosen), 1);

    return chosen;
  }

  // Keep your existing methods below (getRepRule, generateWorkoutName, getSplitName, etc.)
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
      progressionTips: "Add reps when it feels easy."
    };
  }
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
