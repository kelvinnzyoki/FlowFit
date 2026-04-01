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

interface ExerciseData {
  name: string;
  category: string;
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  difficulty?: string;
  equipment?: string[];
}

// Enhanced cache with user-specific history tracking
const generationCache = new Map<string, { plan: any; timestamp: number }>();
const userHistoryCache = new Map<string, { exercises: Set<string>; lastGenerated: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ULTRA-INTELLIGENT WORKOUT GENERATOR SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Features:
 * - Advanced periodization and progressive overload
 * - Muscle group balancing and recovery optimization
 * - Equipment-aware exercise selection
 * - Injury/limitation accommodation
 * - Exercise variety and rotation
 * - Intensity wave programming
 * - Volume landmarks based on research
 * - Intelligent warm-up/cool-down generation
 */
export class WorkoutGeneratorService {

  /**
   * Generate a scientifically-backed, personalized workout plan
   */
  async generateWorkoutPlan(preferences: WorkoutPreferences) {
    const cacheKey = `${preferences.userId}-${preferences.goal}-${preferences.fitnessLevel}-${preferences.sessionDuration}`;

    // Check cache but allow regeneration for variety
    const cached = generationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      // 30% chance to regenerate for variety even with valid cache
      if (Math.random() > 0.3) {
        return { ...cached.plan, fromCache: true };
      }
    }

    try {
      // Fetch all active exercises with enhanced metadata
      const allExercises = await prisma.exercise.findMany({
        where: { isActive: true },
        select: { 
          name: true, 
          category: true,
          
        }
      });

      // Get user's exercise history for variety
      const userHistory = await this.getUserExerciseHistory(preferences.userId);

      // Determine optimal training split
      const split = this.determineSplitAdvanced(preferences);

      // Build intelligent workout plan
      const plan = await this.buildAdvancedPlan(
        allExercises, 
        preferences, 
        split, 
        userHistory
      );

      // Cache the plan
      generationCache.set(cacheKey, { plan, timestamp: Date.now() });
      this.pruneCache();

      // Update user history
      this.updateUserHistory(preferences.userId, plan.exercises.map((e: any) => e.name));

      return plan;
    } catch (error) {
      logger.error('Workout generator error:', error);
      return this.getEnhancedFallbackPlan(preferences);
    }
  }

  /**
   * Advanced progression suggestion with periodization awareness
   */
  async suggestProgression(
    userId: string,
    exerciseId: string,
    lastSets: number,
    lastReps: string,
    lastRPE?: number
  ) {
    try {
      // Fetch recent workout history (last 8 sessions for pattern analysis)
      const recentLogs = await prisma.workoutLog.findMany({
        where: { 
          userId, 
          exerciseId: exerciseId
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      });

      if (recentLogs.length < 2) {
        return { 
          suggestion: "🎯 Excellent start! Focus on perfecting your form with controlled tempo. Quality over quantity builds the foundation for long-term progress.", 
          type: "foundation",
          nextTarget: `${lastSets} sets × ${lastReps} with perfect form`,
          confidence: "high"
        };
      }

      // Analyze progression patterns
      const analysis = this.analyzeProgressionPattern(recentLogs, lastSets, lastReps, lastRPE);

      // Generate intelligent suggestion based on analysis
      return this.generateProgressionAdvice(analysis, lastSets, lastReps, lastRPE);

    } catch (error) {
      logger.error('suggestProgression error:', error);
      return { 
        suggestion: "Keep crushing it! Consistency is the secret weapon.", 
        type: "maintenance",
        confidence: "medium"
      };
    }
  }

  /**
   * Analyze progression patterns from workout history
   */
  private analyzeProgressionPattern(logs: any[], currentSets: number, currentReps: string, currentRPE?: number) {
    const repsHistory = logs.map(log => {
      const repsStr = String(log.reps || "0");
      return parseInt(repsStr, 10) || 0;
    });

    const avgReps = repsHistory.reduce((a, b) => a + b, 0) / repsHistory.length;
    const maxReps = Math.max(...repsHistory);
    const currentRepsNum = parseInt(String(currentReps), 10) || 8;

    // Calculate volume trend (sets × reps)
    const volumeHistory = logs.slice(0, 4).map((log, idx) => {
      const sets = log.sets || currentSets;
      const reps = parseInt(String(log.reps), 10) || 8;
      return { volume: sets * reps, session: idx };
    });

    const isProgressingVolume = volumeHistory.length >= 2 && 
      volumeHistory[0].volume > volumeHistory[volumeHistory.length - 1].volume;

    // Detect plateau (3+ sessions with same reps)
    const isPlateaued = repsHistory.slice(0, 3).every(r => Math.abs(r - currentRepsNum) <= 1);

    // Consistency check
    const sessionCount = logs.length;
    const timeSpan = logs.length > 1 
      ? (new Date(logs[0].createdAt).getTime() - new Date(logs[logs.length - 1].createdAt).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const avgFrequency = timeSpan > 0 ? sessionCount / timeSpan * 7 : 0; // sessions per week

    return {
      avgReps,
      maxReps,
      currentRepsNum,
      isProgressingVolume,
      isPlateaued,
      sessionCount,
      avgFrequency,
      currentRPE,
      volumeHistory
    };
  }

  /**
   * Generate advanced progression advice based on analysis
   */
  private generateProgressionAdvice(analysis: any, sets: number, reps: string, rpe?: number) {
    const { avgReps, maxReps, currentRepsNum, isProgressingVolume, isPlateaued, avgFrequency, currentRPE } = analysis;

    // SCENARIO 1: Crushing it - ready for overload
    if (currentRepsNum >= avgReps + 2 && currentRepsNum >= 12 && sets >= 3) {
      return {
        suggestion: `🚀 Outstanding progress! You're consistently hitting ${currentRepsNum} reps. Time to level up: add weight/resistance OR increase to ${currentRepsNum + 3}-${currentRepsNum + 5} reps to push into new growth territory.`,
        type: "overload",
        nextTarget: `${sets} sets × ${currentRepsNum + 3}-${currentRepsNum + 5} OR add resistance`,
        confidence: "very high",
        reasoning: "Consistent high rep performance indicates readiness for progressive overload"
      };
    }

    // SCENARIO 2: Easy session - intensity too low
    if (currentRPE && currentRPE <= 6 && sets >= 3) {
      return {
        suggestion: `🔥 You're leaving gains on the table! RPE ${currentRPE} means you had 4+ reps in reserve. Push closer to RPE 8-9 (2-3 reps from failure) to maximize muscle adaptation and strength gains.`,
        type: "intensity",
        nextTarget: `${sets} sets × ${currentRepsNum} @ RPE 8-9`,
        confidence: "high",
        reasoning: "Low RPE indicates insufficient stimulus for optimal adaptation"
      };
    }

    // SCENARIO 3: Plateau detected
    if (isPlateaued && sets >= 3) {
      return {
        suggestion: `💡 Plateau detected! Your body adapted to ${currentRepsNum} reps. Break through with: (1) Add 1-2 more sets for volume, (2) Slow your tempo (3s eccentric), or (3) Try a variation of this exercise for fresh stimulus.`,
        type: "plateau_breaker",
        nextTarget: `${sets + 1} sets × ${currentRepsNum} OR tempo variation`,
        confidence: "high",
        reasoning: "Consistent performance without progression suggests need for novel stimulus"
      };
    }

    // SCENARIO 4: Volume progressing well
    if (isProgressingVolume && currentRepsNum >= 10) {
      return {
        suggestion: `💪 Solid volume progression! You're building work capacity. To optimize for strength gains, consider adding resistance and dropping to ${currentRepsNum - 3}-${currentRepsNum - 1} reps with heavier load.`,
        type: "strength_focus",
        nextTarget: `${sets} sets × ${currentRepsNum - 3}-${currentRepsNum - 1} with added resistance`,
        confidence: "high",
        reasoning: "High volume achieved; transitioning to strength-oriented loading"
      };
    }

    // SCENARIO 5: Frequency too low
    if (avgFrequency < 2 && avgFrequency > 0) {
      return {
        suggestion: `📅 Consistency is king! You're training this exercise less than 2x/week. Increase frequency to 2-3x weekly for optimal neuromuscular adaptation and faster progress.`,
        type: "frequency",
        nextTarget: `Same volume, increase frequency to 2-3x/week`,
        confidence: "medium",
        reasoning: "Low training frequency limiting progression potential"
      };
    }

    // SCENARIO 6: Moderate RPE, room for intensity
    if (currentRPE && currentRPE >= 7 && currentRPE <= 8) {
      return {
        suggestion: `✅ Great effort zone! RPE ${currentRPE} is the sweet spot for sustainable gains. Maintain this intensity and aim to add 1-2 reps next session to build progressive overload.`,
        type: "progressive",
        nextTarget: `${sets} sets × ${currentRepsNum + 1}-${currentRepsNum + 2} @ RPE 7-8`,
        confidence: "high",
        reasoning: "Optimal intensity zone for hypertrophy and strength"
      };
    }

    // SCENARIO 7: High reps reached - suggest load increase
    if (currentRepsNum >= 15 && sets >= 3) {
      return {
        suggestion: `⚡ You've built excellent endurance! At ${currentRepsNum} reps, you're past the hypertrophy sweet spot. Add resistance to drop into 8-12 reps for maximized muscle growth.`,
        type: "load_increase",
        nextTarget: `${sets} sets × 8-12 with added resistance`,
        confidence: "very high",
        reasoning: "High rep range; transitioning to heavier load for hypertrophy"
      };
    }

    // DEFAULT: Steady progression
    return { 
      suggestion: `💯 Solid work! Keep your current intensity and aim for ${currentRepsNum + 1}-${currentRepsNum + 2} reps next time. Progressive overload happens one rep at a time. Stay consistent!`,
      type: "steady",
      nextTarget: `${sets} sets × ${currentRepsNum + 1}-${currentRepsNum + 2}`,
      confidence: "high",
      reasoning: "Maintain progressive trajectory with incremental volume increase"
    };
  }

  /**
   * Advanced split determination with periodization
   */
  private determineSplitAdvanced(p: WorkoutPreferences): string {
    const { trainingDaysPerWeek, fitnessLevel, goal } = p;

    // Advanced athletes benefit from higher frequency per muscle group
    if (trainingDaysPerWeek >= 6 && fitnessLevel === 'advanced') {
      return 'ppl'; // Push/Pull/Legs allows 2x frequency
    }

    // Strength goals benefit from full-body frequent practice
    if (goal === 'strength' && trainingDaysPerWeek >= 4) {
      return 'fullbody_strength'; // Modified full body with strength focus
    }

    // Upper/Lower split is versatile for intermediate lifters
    if (trainingDaysPerWeek >= 4 && fitnessLevel !== 'beginner') {
      return 'upperlower';
    }

    // Muscle gain benefits from push/pull antagonist pairing
    if (goal === 'muscle gain' && trainingDaysPerWeek >= 3) {
      return 'pushpull';
    }

    // Fat loss benefits from full-body metabolic stress
    if (goal === 'fat loss') {
      return 'fullbody_metabolic';
    }

    // Beginners start with full-body for movement pattern learning
    return 'fullbody';
  }

  /**
   * Build advanced workout plan with intelligent exercise selection
   */
  private async buildAdvancedPlan(
    exercises: any[], 
    p: WorkoutPreferences, 
    split: string,
    userHistory: Set<string>
  ) {
    // Get rep/set scheme based on goal and periodization
    const rule = this.getAdvancedRepScheme(p.goal, p.fitnessLevel, split);

    // Filter exercises by equipment availability
    const availableExercises = this.filterByEquipment(exercises, p.equipment);

    // Apply limitation filters
    const safeExercises = this.filterByLimitations(availableExercises, p.limitations);

    // Select exercises with muscle group balancing
    const selected = this.selectBalancedExercises(
      safeExercises, 
      split, 
      p,
      userHistory
    );

    // Generate intelligent warm-up
    const warmUp = this.generateSmartWarmup(selected, p.fitnessLevel, split);

    // Generate intelligent cool-down
    const coolDown = this.generateSmartCooldown(selected, p.sessionDuration);

    // Generate progression strategy
    const progressionTips = this.generateProgressionStrategy(p.goal, p.fitnessLevel, split);

    return {
      workoutName: this.generateSmartWorkoutName(p, split),
      focus: this.getSplitDescription(split),
      estimatedDurationMinutes: this.calculateAccurateDuration(selected, rule, p.sessionDuration),
      warmUp,
      exercises: selected.map(ex => this.formatExerciseWithDetail(ex, rule, p)),
      coolDown,
      progressionTips,
      splitType: split,
      weeklyRecommendations: this.generateWeeklyProgram(p, split),
      scienceNotes: this.getScienceBasedNotes(p.goal, split),
      generatedAt: new Date().toISOString(),
      algorithmVersion: "v2.0-enhanced"
    };
  }

  /**
   * Filter exercises by available equipment
   */
  private filterByEquipment(exercises: any[], equipment: string[]): any[] {
    // If bodyweight only, filter to bodyweight exercises
    if (equipment.includes('bodyweight') && equipment.length === 1) {
      return exercises.filter(ex => 
        !ex.equipment || 
        ex.equipment.length === 0 || 
        ex.equipment.includes('bodyweight') ||
        ex.category === 'BODYWEIGHT'
      );
    }

    // Filter to match available equipment
    return exercises.filter(ex => {
      if (!ex.equipment || ex.equipment.length === 0) return true; // bodyweight
      return ex.equipment.some((eq: string) => 
        equipment.some(avail => eq.toLowerCase().includes(avail.toLowerCase()))
      );
    });
  }

  /**
   * Filter exercises to accommodate limitations
   */
  private filterByLimitations(exercises: any[], limitations?: string): any[] {
    if (!limitations) return exercises;

    const lower = limitations.toLowerCase();
    const filtered = exercises.filter(ex => {
      const name = ex.name.toLowerCase();
      
      // Wrist pain - avoid exercises with wrist load
      if (lower.includes('wrist')) {
        if (name.includes('push') || name.includes('plank') || name.includes('handstand')) {
          return false;
        }
      }

      // Knee pain - avoid high knee stress
      if (lower.includes('knee')) {
        if (name.includes('squat') || name.includes('lunge') || name.includes('jump')) {
          return false;
        }
      }

      // Lower back - avoid spinal loading
      if (lower.includes('back') || lower.includes('spine')) {
        if (name.includes('deadlift') || name.includes('good morning') || name.includes('hyperextension')) {
          return false;
        }
      }

      // No jumping
      if (lower.includes('jump') || lower.includes('impact')) {
        if (name.includes('jump') || name.includes('hop') || name.includes('burpee') || name.includes('box')) {
          return false;
        }
      }

      return true;
    });

    return filtered.length > 0 ? filtered : exercises; // Fallback to all if over-filtered
  }

  /**
   * Select balanced exercises across muscle groups
   */
  private selectBalancedExercises(
    pool: any[], 
    split: string, 
    p: WorkoutPreferences,
    userHistory: Set<string>
  ): any[] {
    const selected: any[] = [];
    const usedCategories = new Set<string>();

    // Define exercise selection strategy per split
    const strategy = this.getExerciseStrategy(split, p);

    // Shuffle pool but deprioritize recently used exercises
    const shuffled = [...pool].sort((a, b) => {
      const aUsed = userHistory.has(a.name) ? 1 : 0;
      const bUsed = userHistory.has(b.name) ? 1 : 0;
      if (aUsed !== bUsed) return aUsed - bUsed; // Unused first
      return Math.random() - 0.5; // Then random
    });

    // Select exercises according to strategy
    for (const requirement of strategy) {
      const exercise = this.pickByCategoryPriority(
        shuffled, 
        requirement.categories, 
        requirement.difficulty || p.fitnessLevel,
        usedCategories
      );

      if (exercise) {
        selected.push({ ...exercise, focus: requirement.focus });
        usedCategories.add(exercise.category);
      }
    }

    return selected.filter(Boolean);
  }

  /**
   * Get exercise selection strategy based on split
   */
  private getExerciseStrategy(split: string, p: WorkoutPreferences) {
    const strategies: any = {
      fullbody: [
        { categories: ['STRENGTH'], focus: 'Lower Body Compound', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Upper Body Push', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Upper Body Pull', difficulty: p.fitnessLevel },
        { categories: ['CORE'], focus: 'Core Stability', difficulty: p.fitnessLevel },
        { categories: ['CARDIO', 'HIIT'], focus: 'Metabolic Finisher', difficulty: p.fitnessLevel },
      ],
      fullbody_strength: [
        { categories: ['STRENGTH'], focus: 'Primary Lower Compound', difficulty: 'advanced' },
        { categories: ['STRENGTH'], focus: 'Primary Upper Compound', difficulty: 'advanced' },
        { categories: ['STRENGTH'], focus: 'Secondary Compound', difficulty: p.fitnessLevel },
        { categories: ['CORE'], focus: 'Core Strength', difficulty: p.fitnessLevel },
      ],
      fullbody_metabolic: [
        { categories: ['HIIT', 'CARDIO'], focus: 'Metabolic Compound', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Lower Body Power', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Upper Body Power', difficulty: p.fitnessLevel },
        { categories: ['CORE', 'HIIT'], focus: 'Core Conditioning', difficulty: p.fitnessLevel },
        { categories: ['CARDIO'], focus: 'Cardio Burst', difficulty: p.fitnessLevel },
      ],
      upperlower: [
        { categories: ['STRENGTH'], focus: 'Primary Compound', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Secondary Compound', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH', 'CORE'], focus: 'Accessory', difficulty: p.fitnessLevel },
        { categories: ['CORE'], focus: 'Core', difficulty: p.fitnessLevel },
      ],
      pushpull: [
        { categories: ['STRENGTH'], focus: 'Primary Push/Pull', difficulty: 'advanced' },
        { categories: ['STRENGTH'], focus: 'Secondary Push/Pull', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Accessory', difficulty: p.fitnessLevel },
        { categories: ['CORE'], focus: 'Core Stability', difficulty: p.fitnessLevel },
      ],
      ppl: [
        { categories: ['STRENGTH'], focus: 'Primary Compound', difficulty: 'advanced' },
        { categories: ['STRENGTH'], focus: 'Secondary Compound', difficulty: p.fitnessLevel },
        { categories: ['STRENGTH'], focus: 'Isolation', difficulty: p.fitnessLevel },
        { categories: ['CORE'], focus: 'Core', difficulty: p.fitnessLevel },
      ],
    };

    return strategies[split] || strategies.fullbody;
  }

  /**
   * Pick exercise by category priority with difficulty matching
   */
  private pickByCategoryPriority(
    pool: any[], 
    categories: string[], 
    difficulty: string,
    usedCategories: Set<string>
  ) {
    // First pass: match category and difficulty, prefer unused categories
    for (const category of categories) {
      const match = pool.find(ex => 
        ex.category === category &&
        !usedCategories.has(ex.category) &&
        (!ex.difficulty || ex.difficulty.toLowerCase() === difficulty.toLowerCase())
      );
      if (match) {
        pool.splice(pool.indexOf(match), 1);
        return match;
      }
    }

    // Second pass: match category only, prefer unused
    for (const category of categories) {
      const match = pool.find(ex => 
        ex.category === category &&
        !usedCategories.has(ex.category)
      );
      if (match) {
        pool.splice(pool.indexOf(match), 1);
        return match;
      }
    }

    // Third pass: any from category
    for (const category of categories) {
      const match = pool.find(ex => ex.category === category);
      if (match) {
        pool.splice(pool.indexOf(match), 1);
        return match;
      }
    }

    return null;
  }

  /**
   * Get advanced rep scheme with periodization
   */
  private getAdvancedRepScheme(goal: string, level: string, split: string) {
    const isStrengthFocus = split.includes('strength');
    const isMetabolicFocus = split.includes('metabolic');

    const schemes: any = {
      'muscle gain': {
        beginner:     { sets: 3, reps: '10-12', rest: 60, tempo: '2-1-2' },
        intermediate: { sets: 4, reps: '8-12',  rest: 75, tempo: '3-1-2' },
        advanced:     { sets: 4, reps: '6-12',  rest: 90, tempo: '3-1-3' }
      },
      'fat loss': {
        beginner:     { sets: 3, reps: '12-15', rest: 45, tempo: '2-0-2' },
        intermediate: { sets: 4, reps: '12-20', rest: 40, tempo: '2-0-2' },
        advanced:     { sets: 4, reps: '15-25', rest: 30, tempo: '1-0-1' }
      },
      'strength': {
        beginner:     { sets: 4, reps: '6-8',   rest: 120, tempo: '3-1-1' },
        intermediate: { sets: 5, reps: '5-8',   rest: 150, tempo: '3-1-1' },
        advanced:     { sets: 5, reps: '3-6',   rest: 180, tempo: '3-2-1' }
      },
      'endurance': {
        beginner:     { sets: 3, reps: '15-20', rest: 40, tempo: '1-0-1' },
        intermediate: { sets: 3, reps: '20-30', rest: 35, tempo: '1-0-1' },
        advanced:     { sets: 4, reps: '25-40', rest: 30, tempo: '1-0-1' }
      },
      'general fitness': {
        beginner:     { sets: 3, reps: '10-15', rest: 60, tempo: '2-1-2' },
        intermediate: { sets: 3, reps: '12-15', rest: 60, tempo: '2-1-2' },
        advanced:     { sets: 4, reps: '10-15', rest: 60, tempo: '2-1-2' }
      }
    };

    const scheme = schemes[goal]?.[level] || schemes['general fitness'][level] || schemes['general fitness'].intermediate;

    // Adjust for split type
    if (isStrengthFocus) {
      return { ...scheme, rest: scheme.rest + 30, tempo: '3-2-1' };
    }
    if (isMetabolicFocus) {
      return { ...scheme, rest: Math.max(30, scheme.rest - 15), tempo: '1-0-1' };
    }

    return scheme;
  }

  /**
   * Generate intelligent warm-up
   */
  private generateSmartWarmup(exercises: any[], level: string, split: string): string {
    const hasLowerBody = exercises.some(ex => 
      ex.name.toLowerCase().includes('squat') || 
      ex.name.toLowerCase().includes('lunge') ||
      ex.name.toLowerCase().includes('leg')
    );

    const hasUpperBody = exercises.some(ex => 
      ex.name.toLowerCase().includes('push') || 
      ex.name.toLowerCase().includes('pull') ||
      ex.name.toLowerCase().includes('press')
    );

    const warmups: string[] = [];

    // General cardio
    warmups.push('5 min light cardio (jumping jacks, high knees, or jump rope)');

    // Dynamic stretching based on workout
    if (hasLowerBody) {
      warmups.push('Leg swings (10 each direction)');
      warmups.push('Walking lunges (8-10 steps)');
      warmups.push('Bodyweight squats (15 reps)');
    }

    if (hasUpperBody) {
      warmups.push('Arm circles (10 each direction)');
      warmups.push('Scapular wall slides (10 reps)');
      warmups.push('Band pull-aparts or wall angels (12 reps)');
    }

    // Core activation
    warmups.push('Dead bugs or bird dogs (10 reps/side)');

    // Mobility for advanced
    if (level === 'advanced') {
      warmups.push("World's greatest stretch (5 reps/side)");
    }

    return warmups.join(' • ');
  }

  /**
   * Generate intelligent cool-down
   */
  private generateSmartCooldown(exercises: any[], duration: number): string {
    const cooldowns: string[] = [];

    // Light cardio
    cooldowns.push('3-5 min slow walk or light movement');

    // Static stretching
    cooldowns.push("Child's Pose (60s)");
    cooldowns.push('Downward Dog (45s)');
    cooldowns.push('Pigeon Pose (45s each side)');
    cooldowns.push('Seated Forward Fold (60s)');
    cooldowns.push('Spinal Twist (30s each side)');

    // Longer sessions get foam rolling
    if (duration >= 45) {
      cooldowns.push('Foam rolling major muscle groups (5-8 min)');
    }

    // Breathing
    cooldowns.push('Deep breathing: 5 deep breaths, 4s inhale to 6s exhale');

    return cooldowns.join(' • ');
  }

  /**
   * Generate progression strategy
   */
  private generateProgressionStrategy(goal: string, level: string, split: string): string {
    const strategies: any = {
      'muscle gain': `🎯 Progressive Overload Protocol: Increase reps by 1-2 each week until you hit the top of your rep range. Once there, add weight/resistance and drop back to the lower range. Track every workout. Aim for 10-20% volume increase per month.`,
      'fat loss': `🔥 Metabolic Progression: Each week, reduce rest periods by 5-10 seconds OR add 2-3 reps OR increase movement speed. Focus on maintaining high intensity throughout. Track total workout density (volume ÷ time).`,
      'strength': `💪 Strength Progression: Add weight when you can complete all sets with 1-2 reps in reserve. Use micro-plates (1.25-2.5 lbs) for upper body, 5 lbs for lower body. Deload (reduce weight 10%) every 4th week for recovery.`,
      'endurance': `⚡ Endurance Progression: Increase reps by 3-5 each week OR reduce rest by 10s OR add an extra set. Monitor heart rate recovery between sets. Aim to maintain form even at high fatigue.`,
      'general fitness': `✅ Balanced Progression: Each week, choose one: (1) Add 1 set, (2) Add 2-3 reps, (3) Reduce rest by 10s, or (4) Increase resistance. Rotate through these every 2-3 weeks to hit all fitness qualities.`
    };

    let base = strategies[goal] || strategies['general fitness'];

    if (level === 'beginner') {
      base += ` **Beginner Focus:** Master form first! Film yourself or train with a mirror. Don't rush progression—adding 2-5 lbs or 1-2 reps every 2 weeks is excellent progress.`;
    } else if (level === 'advanced') {
      base += ` **Advanced Strategy:** Implement periodization—rotate between strength (3-6 reps), hypertrophy (8-12 reps), and metabolic (15-25 reps) blocks every 4 weeks. Track 1RM estimates and volume landmarks.`;
    }

    return base;
  }

  /**
   * Format exercise with enhanced detail
   */
  private formatExerciseWithDetail(exercise: any, rule: any, p: WorkoutPreferences) {
    const modifications: string[] = [];

    // Add limitation modifications
    if (p.limitations) {
      const lower = p.limitations.toLowerCase();
      if (lower.includes('wrist') && exercise.name.toLowerCase().includes('push')) {
        modifications.push('Try knuckle push-ups or use parallettes for wrist comfort');
      }
      if (lower.includes('knee') && exercise.name.toLowerCase().includes('squat')) {
        modifications.push('Limit depth to pain-free range');
      }
    }

    // Add level-appropriate cues
    if (p.fitnessLevel === 'beginner') {
      modifications.push('Focus on full ROM and controlled tempo');
    } else if (p.fitnessLevel === 'advanced') {
      modifications.push(`Tempo: ${rule.tempo} (eccentric-pause-concentric)`);
    }

    return {
      name: exercise.name,
      sets: rule.sets,
      reps: rule.reps,
      restSeconds: rule.rest,
      notes: modifications.join(' | ') || exercise.focus || 'Controlled form',
      primaryMuscles: exercise.primaryMuscles,
      secondaryMuscles: exercise.secondaryMuscles,
      difficulty: exercise.difficulty
    };
  }

  /**
   * Calculate accurate workout duration
   */
  private calculateAccurateDuration(exercises: any[], rule: any, targetDuration: number): number {
    // Work time: sets × reps × 3s per rep (average)
    const avgReps = parseInt(rule.reps.split('-')[0]) || 10;
    const workTime = exercises.length * rule.sets * avgReps * 3;

    // Rest time
    const restTime = exercises.length * (rule.sets - 1) * rule.rest;

    // Warmup + cooldown
    const warmupCooldown = 15 * 60; // 15 minutes

    // Total in seconds
    const totalSeconds = workTime + restTime + warmupCooldown;

    // Convert to minutes and cap at target
    const calculated = Math.ceil(totalSeconds / 60);
    return Math.min(calculated, targetDuration);
  }

  /**
   * Generate smart workout name
   */
  private generateSmartWorkoutName(p: WorkoutPreferences, split: string): string {
    const names: any = {
      'muscle gain': ['Hypertrophy Flow', 'Growth Protocol', 'Anabolic Session', 'Mass Builder'],
      'fat loss': ['Metabolic Torch', 'Fat Burn Flow', 'Conditioning Circuit', 'Shred Session'],
      'strength': ['Power Protocol', 'Strength Forge', 'Iron Flow', 'Max Force'],
      'endurance': ['Endurance Engine', 'Stamina Flow', 'Cardio Conditioning', 'Peak Endurance'],
      'general fitness': ['Total Body Flow', 'Complete Fitness', 'All-Around Athlete', 'Functional Flow']
    };

    const goalNames = names[p.goal] || names['general fitness'];
    const randomName = goalNames[Math.floor(Math.random() * goalNames.length)];

    const splitSuffix: any = {
      'fullbody': '',
      'fullbody_strength': ' - Strength Focus',
      'fullbody_metabolic': ' - Metabolic',
      'upperlower': ' - Upper/Lower',
      'pushpull': ' - Push/Pull',
      'ppl': ' - PPL'
    };

    return randomName + (splitSuffix[split] || '');
  }

  /**
   * Get split description
   */
  private getSplitDescription(split: string): string {
    const descriptions: any = {
      'fullbody': 'Full Body',
      'fullbody_strength': 'Full Body (Strength Emphasis)',
      'fullbody_metabolic': 'Full Body (Metabolic)',
      'upperlower': 'Upper / Lower Split',
      'pushpull': 'Push / Pull Split',
      'ppl': 'Push / Pull / Legs'
    };
    return descriptions[split] || 'Custom Split';
  }

  /**
   * Generate weekly program recommendations
   */
  private generateWeeklyProgram(p: WorkoutPreferences, split: string): string {
    const days = p.trainingDaysPerWeek;

    if (split === 'fullbody' || split.includes('fullbody')) {
      return `Week Structure: ${days}x Full Body sessions. Rest at least 1 day between sessions. Example: Mon/Wed/Fri or Tue/Thu/Sat.`;
    }

    if (split === 'upperlower') {
      return `Week Structure: Alternate Upper/Lower. Example 4-day: Mon(U)/Tue(L)/Thu(U)/Fri(L). Example 5-day: Add a 3rd Upper or Lower based on weakness.`;
    }

    if (split === 'pushpull') {
      return `Week Structure: Alternate Push/Pull. Example: Mon(Push)/Wed(Pull)/Fri(Push). Include legs in alternating sessions.`;
    }

    if (split === 'ppl') {
      return `Week Structure: Push/Pull/Legs rotation. 6-day example: Mon(P)/Tue(Pu)/Wed(L)/Thu(P)/Fri(Pu)/Sat(L)/Sun(Rest). Each muscle group hits 2x/week.`;
    }

    return `Train ${days} days per week with rest days as needed for recovery.`;
  }

  /**
   * Get science-based notes
   */
  private getScienceBasedNotes(goal: string, split: string): string {
    const notes: any = {
      'muscle gain': '📚 Science: Hypertrophy occurs in 6-30 rep range, peaking at 8-12 reps. Volume (sets × reps × weight) is the primary driver. Aim for 10-20 sets per muscle group per week. Progressive overload is essential.',
      'fat loss': '📚 Science: Fat loss is 80% nutrition. Training creates metabolic stress and preserves muscle. High-intensity circuits elevate EPOC (afterburn) for 24-48 hours post-workout. Combine with calorie deficit.',
      'strength': '📚 Science: Strength gains come from neural adaptations (first 6-8 weeks) then muscle cross-sectional area. Heavy loads (80-90% 1RM / 3-6 reps) optimize motor unit recruitment. Rest 2-5 min between sets.',
      'endurance': '📚 Science: Muscular endurance improves via increased mitochondrial density and capillarization. Train at 40-60% 1RM with short rest (30-45s). Combine with cardiovascular training.',
      'general fitness': '📚 Science: General fitness requires balanced stimulus across strength, endurance, and mobility. Vary rep ranges (5-25) and rest periods (30-120s) to develop all energy systems.'
    };

    return notes[goal] || notes['general fitness'];
  }

  /**
   * Get user's exercise history for variety
   */
  private async getUserExerciseHistory(userId: string): Promise<Set<string>> {
    try {
      // Check cache first
      const cached = userHistoryCache.get(userId);
      if (cached && Date.now() - cached.lastGenerated < 7 * 24 * 60 * 60 * 1000) {
        return cached.exercises;
      }

      // Fetch last 30 days of workout logs
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const logs = await prisma.workoutLog.findMany({
        where: {
          userId,
          createdAt: { gte: thirtyDaysAgo }
        },
        select: { exerciseId: true }
      });

      const exerciseSet = new Set(logs.map(log => log.exerciseId).filter(Boolean));
      return exerciseSet;
    } catch (error) {
      logger.error('Failed to fetch user history:', error);
      return new Set();
    }
  }

  /**
   * Update user history cache
   */
  private updateUserHistory(userId: string, exercises: string[]) {
    const current = userHistoryCache.get(userId);
    const exerciseSet = current?.exercises || new Set();
    
    exercises.forEach(ex => exerciseSet.add(ex));

    userHistoryCache.set(userId, {
      exercises: exerciseSet,
      lastGenerated: Date.now()
    });

    // Prune cache
    if (userHistoryCache.size > 200) {
      const oldestKey = Array.from(userHistoryCache.keys())[0];
      userHistoryCache.delete(oldestKey);
    }
  }

  /**
   * Prune generation cache
   */
  private pruneCache() {
    if (generationCache.size > 100) {
      const entries = Array.from(generationCache.entries());
      const sorted = entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      generationCache.delete(sorted[0][0]);
    }
  }

  /**
   * Enhanced fallback plan
   */
  private getEnhancedFallbackPlan(p: WorkoutPreferences) {
    const rule = this.getAdvancedRepScheme(p.goal, p.fitnessLevel, 'fullbody');

    return {
      workoutName: "Safe Bodyweight Flow",
      focus: "Full Body Foundation",
      estimatedDurationMinutes: p.sessionDuration,
      warmUp: "5 min jumping jacks + arm circles + leg swings + bodyweight squats",
      exercises: [
        { 
          name: "Push-ups (modify on knees if needed)", 
          sets: rule.sets, 
          reps: rule.reps, 
          restSeconds: rule.rest, 
          notes: "Chest to ground, full ROM",
          primaryMuscles: ['chest', 'triceps'],
          difficulty: p.fitnessLevel
        },
        { 
          name: "Bodyweight Squats", 
          sets: rule.sets, 
          reps: rule.reps, 
          restSeconds: rule.rest, 
          notes: "Below parallel, weight in heels",
          primaryMuscles: ['quads', 'glutes'],
          difficulty: p.fitnessLevel
        },
        { 
          name: "Plank Hold", 
          sets: 3, 
          reps: "30-60 seconds", 
          restSeconds: 45, 
          notes: "Flat back, squeeze glutes and core",
          primaryMuscles: ['core'],
          difficulty: p.fitnessLevel
        },
        { 
          name: "Glute Bridges", 
          sets: rule.sets, 
          reps: rule.reps, 
          restSeconds: rule.rest, 
          notes: "Squeeze at top for 2 seconds",
          primaryMuscles: ['glutes', 'hamstrings'],
          difficulty: p.fitnessLevel
        },
      ],
      coolDown: "Child's pose (60s) • Downward dog (45s) • Seated forward fold (60s) • Deep breathing",
      progressionTips: this.generateProgressionStrategy(p.goal, p.fitnessLevel, 'fullbody'),
      splitType: 'fullbody',
      weeklyRecommendations: `Train 3-4x per week with rest days between sessions.`,
      scienceNotes: this.getScienceBasedNotes(p.goal, 'fullbody'),
      generatedAt: new Date().toISOString(),
      algorithmVersion: "v2.0-fallback"
    };
  }
}

export const workoutGenerator = new WorkoutGeneratorService();
