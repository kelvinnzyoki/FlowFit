// aiCoach.service.ts — ULTRA-INTELLIGENT AI FITNESS COACH
// Implements all 22 intelligence modules from the feature specification.
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════

interface UserProfile {
  id: string;
  name?: string;
  age?: number;
  weight?: number;
  height?: number;
  gender?: string;
  fitnessGoal?: 'fat_loss' | 'muscle_gain' | 'endurance' | 'mobility' | 'general_fitness';
  fitnessLevel?: 'beginner' | 'intermediate' | 'advanced';
  availableEquipment?: string[];
  injuries?: string[];
  preferences?: any;
}

interface WorkoutLog {
  id: string;
  userId: string;
  exerciseId: string;
  sets: number;
  reps: number;
  weight?: number;
  duration?: number;
  completed: boolean;
  skipped: boolean;
  fatigue?: number;   // 1-10
  pain?: number;      // 1-10
  mood?: string;
  createdAt: Date;
  exercise?: any;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  context?: any;
}

interface CoachContext {
  userId: string;
  currentExercise?: string;
  currentWorkout?: string;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  availableTime?: number;   // minutes
  equipment?: string[];
  mood?: string;
  energyLevel?: number;     // 1-10
  environment?: 'gym' | 'home' | 'outdoors' | 'travel' | 'limited_space';
  isNoisy?: boolean;
}

interface WorkoutPlan {
  type: string;
  duration: number;
  exercises: Exercise[];
  warmup: Exercise[];
  cooldown: Exercise[];
  notes: string[];
  dietSuggestion?: string;  // [Feature 20] every workout includes diet suggestion
  periodPhase?: string;     // [Feature 7] periodization phase
}

interface Exercise {
  name: string;
  sets: number;
  reps: number | string;
  rest: number;
  intensity: 'low' | 'moderate' | 'high';
  modifications?: string[];
  formTips?: string[];
  tempoNotes?: string;      // [Feature 7] tempo variations
}

// [Feature 1+2] Per-user session state — memory + pending action engine
interface SessionState {
  conversationHistory: ChatMessage[];
  pendingAction: PendingAction | null;
  lastIntent: string;
  lastInjury: string | null;
  lastFatigue: number | null;
  lastMood: string | null;
  lastWorkoutType: string | null;
  lastDeclinedSuggestion: string | null;
  rejectedSuggestions: string[];
  greetingVariantIndex: number;
  preferredIntensity: string | null;
  dislikedExercises: string[];
  likedExercises: string[];
  rpeHistory: number[];               // [Feature 12] RPE tracking
  behaviorScore: number;              // [Feature 22] behavioral scoring
  lastInteractionTime: Date | null;
  injuryHistory: InjuryRecord[];
  weeklyFeedback: WorkoutFeedback[];
}

interface PendingAction {
  type: 'injury_workout' | 'fatigue_adjust' | 'confirm_plan' | 'schedule_set' | 'goal_change' | 'deload_confirm';
  data: any;
  prompt: string;
  timestamp: Date;
}

interface InjuryRecord {
  bodyPart: string;
  severity: 'mild' | 'moderate' | 'severe';
  reportedAt: Date;
  resolved: boolean;
}

interface WorkoutFeedback {
  date: Date;
  rpe: number;
  liked: boolean;
  workoutType: string;
}

// ═══════════════════════════════════════════════════════════════════
// AI COACH SERVICE — MAIN CLASS
// ═══════════════════════════════════════════════════════════════════

export class AICoachService {
  // [Feature 1] Per-user session state (short-term + long-term memory)
  private sessions = new Map<string, SessionState>();

  private getSession(userId: string): SessionState {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {
        conversationHistory:    [],
        pendingAction:          null,
        lastIntent:             '',
        lastInjury:             null,
        lastFatigue:            null,
        lastMood:               null,
        lastWorkoutType:        null,
        lastDeclinedSuggestion: null,
        rejectedSuggestions:    [],
        greetingVariantIndex:   0,
        preferredIntensity:     null,
        dislikedExercises:      [],
        likedExercises:         [],
        rpeHistory:             [],
        behaviorScore:          50,
        lastInteractionTime:    null,
        injuryHistory:          [],
        weeklyFeedback:         [],
      });
    }
    return this.sessions.get(userId)!;
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════

  async getResponse(userId: string, message: string, context: CoachContext) {
    const session = this.getSession(userId);
    const lower   = message.toLowerCase().trim();

    // [Feature 1] Store message in conversation history (keep last 20)
    session.conversationHistory.push({ role: 'user', content: message, timestamp: new Date(), context });
    if (session.conversationHistory.length > 20) session.conversationHistory.shift();

    // [Feature 3] Infer time of day if not provided
    if (!context.timeOfDay) {
      const h = new Date().getHours();
      context.timeOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
    }

    // [Feature 22] Detect long inactivity and nudge
    const inactivityNudge = this.checkInactivity(session);
    if (inactivityNudge) {
      session.lastInteractionTime = new Date();
      return inactivityNudge;
    }
    session.lastInteractionTime = new Date();

    // Fetch user data
    const userData = await this.getUserData(userId);
    const { userProfile, workoutLogs, progressData } = userData;

    // [Feature 2] Resolve pending action first (confirmation-based execution)
    const pendingResolution = this.resolvePendingAction(session, lower, userProfile, workoutLogs, context);
    if (pendingResolution) return pendingResolution;

    // Detect intent
    const intent = this.detectIntent(lower, context, session);
    session.lastIntent = intent.type;

    // [Feature 12] Detect RPE / difficulty feedback
    const rpeFeedback = this.detectRPEFeedback(lower, session);
    if (rpeFeedback) return rpeFeedback;

    // [Feature 10] Detect and reinforce habit / streak patterns
    const habitNudge = this.checkHabitNudge(lower, progressData, session);
    if (habitNudge) return habitNudge;

    // Route to handler
    switch (intent.type) {
      case 'greeting':
        return this.handleGreeting(userId, userProfile, workoutLogs, progressData, context, session);
      case 'workout_request':
        return this.handleWorkoutRequest(userId, userProfile, workoutLogs, progressData, context, intent, session);
      case 'form_technique':
        return this.handleFormTechnique(lower, context, workoutLogs);
      case 'injury_pain':
        return this.handleInjuryPain(lower, context, userProfile, workoutLogs, session);
      case 'motivation':
        return this.handleMotivation(userId, userProfile, workoutLogs, progressData, session);
      case 'progress_check':
        return this.handleProgressCheck(userId, workoutLogs, progressData, session);
      case 'nutrition':
        return this.handleNutrition(userProfile, workoutLogs, intent, progressData);
      case 'recovery':
        return this.handleRecovery(userProfile, workoutLogs, session);
      case 'fatigue':
        return this.handleFatigue(userId, userProfile, workoutLogs, context, session);
      case 'schedule':
        return this.handleScheduling(userId, userProfile, workoutLogs, context, session);
      case 'environment':
        return this.handleEnvironment(context, userProfile, workoutLogs, session);
      case 'deload':
        return this.handleDeload(userId, userProfile, workoutLogs, session);
      case 'goal_change':
        return this.handleGoalChange(lower, session);
      case 'feedback':
        return this.handleFeedback(lower, userProfile, workoutLogs, session);
      case 'daily_summary':
        return this.handleDailySummary(userId, workoutLogs, progressData, context);
      default:
        return this.handleDefault(userId, userProfile, workoutLogs, lower, session);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 2] PENDING ACTION RESOLUTION — confirmation engine
  // ═══════════════════════════════════════════════════════════════════

  private resolvePendingAction(
    session: SessionState,
    lower: string,
    userProfile: any,
    workoutLogs: any[],
    context: CoachContext
  ) {
    const pending = session.pendingAction;
    if (!pending) return null;

    // Timeout pending action after 10 minutes
    const ageMs = Date.now() - pending.timestamp.getTime();
    if (ageMs > 600_000) { session.pendingAction = null; return null; }

    const isYes = /\b(yes|yeah|yep|yup|sure|ok|okay|go|do it|sounds good|let's|lets|please|correct|right|good|great)\b/.test(lower);
    const isNo  = /\b(no|nah|nope|not now|skip|later|pass|maybe|don't|dont|cancel|stop)\b/.test(lower);

    if (!isYes && !isNo) return null; // Not a confirmation — let normal routing handle it

    session.pendingAction = null;

    if (isNo) {
      session.lastDeclinedSuggestion = pending.type;
      session.rejectedSuggestions.push(pending.type);
      return {
        success: true,
        reply: `No worries! ${this.getAlternativeToDecline(pending.type)}`,
        type: 'alternative_offer',
        suggestions: this.getDefaultSuggestions()
      };
    }

    // YES — execute the pending action
    switch (pending.type) {
      case 'injury_workout': {
        const { bodyPart, alternatives } = pending.data;
        const workout = this.generateInjurySafeWorkout(bodyPart, userProfile, workoutLogs, context);
        return {
          success: true,
          reply: `Here is your ${bodyPart}-safe workout — all exercises avoid stressing that area:`,
          type: 'workout_plan',
          workout,
          dietSuggestion: this.getPostWorkoutDiet(userProfile?.fitnessGoal || 'general_fitness'),
          suggestions: ['Log this workout', 'Make it easier', 'Recovery tips']
        };
      }
      case 'fatigue_adjust': {
        const { originalGoal } = pending.data;
        return {
          success: true,
          reply: `Volume reduced by 30%. Here is a lighter session focused on form and active recovery:`,
          type: 'workout_plan',
          workout: this.generateLightWorkout(userProfile, workoutLogs, context),
          suggestions: ['Start workout', 'Take full rest instead', 'How to recover faster']
        };
      }
      case 'deload_confirm': {
        return this.executeDeload(userProfile, workoutLogs, context);
      }
      case 'confirm_plan': {
        return {
          success: true,
          reply: `Confirmed! Your plan is set. Here are your quick-start tips:\n\n• Warm up for 5 minutes\n• Stay hydrated throughout\n• Track your sets and reps\n• Cool down after\n\nLet's go! 💪`,
          type: 'confirmation',
          suggestions: ['Start now', 'Remind me tonight', 'Log my workout']
        };
      }
      default:
        return null;
    }
  }

  private getAlternativeToDecline(pendingType: string): string {
    const map: Record<string, string> = {
      injury_workout:  'Want a full rest day or active recovery like walking and stretching instead?',
      fatigue_adjust:  'Want to take a complete rest day today?',
      deload_confirm:  'Okay, keep your current training load. Let me know if you feel overworked.',
      confirm_plan:    'Let me know when you are ready and I will generate a fresh plan.',
    };
    return map[pendingType] || 'What would you like to do instead?';
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 8+1] INTENT DETECTION — natural language + state-aware
  // ═══════════════════════════════════════════════════════════════════

  private detectIntent(message: string, context: CoachContext, session: SessionState) {
    const greetings        = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'what\'s up', 'sup', 'morning', 'evening', 'afternoon', 'night'];
    const workoutKeywords  = ['workout', 'exercise', 'train', 'session', 'routine', 'plan', 'split', 'wod', 'sets', 'reps', 'lift'];
    const formKeywords     = ['form', 'technique', 'how to', 'proper', 'correct', 'position', 'stance'];
    const injuryKeywords   = ['hurt', 'pain', 'injury', 'sore', 'ache', 'strain', 'sprain', 'tweak', 'modify', 'alternative', 'can\'t do', 'avoid'];
    const motivationKws    = ['motivate', 'inspire', 'hard', 'difficult', 'struggle', 'give up', 'quit', 'not feeling', 'unmotivated', 'lazy'];
    const progressKeywords = ['progress', 'results', 'improvement', 'plateau', 'stuck', 'gains', 'tracking', 'stats', 'record'];
    const nutritionKws     = ['nutrition', 'diet', 'eat', 'protein', 'calories', 'meal', 'food', 'macro', 'carb', 'fat', 'supplement', 'hydration', 'water', 'hungry'];
    const recoveryKeywords = ['recover', 'rest day', 'recovery', 'stretching', 'cool down', 'deload', 'overtraining', 'sore muscles'];
    const fatigueKeywords  = ['tired', 'fatigue', 'exhausted', 'energy', 'lighter', 'easy', 'drained', 'burnt out', 'low energy'];
    const scheduleKeywords = ['schedule', 'time', 'when', 'busy', 'quick', 'short', 'only have', 'minutes', 'limited time'];
    const envKeywords      = ['home', 'gym', 'outside', 'outdoor', 'travel', 'hotel', 'small space', 'quiet', 'no equipment', 'without'];
    const deloadKeywords   = ['deload', 'over-trained', 'overtraining', 'too much', 'back off', 'reduce load'];
    const goalKeywords     = ['change goal', 'new goal', 'switch to', 'want to', 'focus on', 'start bulking', 'start cutting'];
    const feedbackKws      = ['too easy', 'too hard', 'loved it', 'hated it', 'that was', 'felt great', 'felt bad', 'liked', 'disliked', 'enjoyed', 'rating'];
    const summaryKws       = ['summary', 'how did i do', 'daily report', 'today\'s stats', 'what did i', 'weekly recap'];

    if (greetings.some(g  => message.startsWith(g) || message === g)) return { type: 'greeting',     confidence: 1.0 };
    if (deloadKeywords.some(k => message.includes(k)))                 return { type: 'deload',       confidence: 0.95 };
    if (injuryKeywords.some(k => message.includes(k)))                 return { type: 'injury_pain',  confidence: 0.95 };
    if (fatigueKeywords.some(k => message.includes(k)))                return { type: 'fatigue',      confidence: 0.92 };
    if (feedbackKws.some(k => message.includes(k)))                    return { type: 'feedback',     confidence: 0.9 };
    if (summaryKws.some(k => message.includes(k)))                     return { type: 'daily_summary',confidence: 0.9 };
    if (workoutKeywords.some(k => message.includes(k)))                return { type: 'workout_request', confidence: 0.9 };
    if (formKeywords.some(k => message.includes(k)))                   return { type: 'form_technique',  confidence: 0.9 };
    if (motivationKws.some(k => message.includes(k)))                  return { type: 'motivation',   confidence: 0.85 };
    if (progressKeywords.some(k => message.includes(k)))               return { type: 'progress_check', confidence: 0.9 };
    if (nutritionKws.some(k => message.includes(k)))                   return { type: 'nutrition',    confidence: 0.85 };
    if (recoveryKeywords.some(k => message.includes(k)))               return { type: 'recovery',     confidence: 0.9 };
    if (scheduleKeywords.some(k => message.includes(k)))               return { type: 'schedule',     confidence: 0.8 };
    if (envKeywords.some(k => message.includes(k)))                    return { type: 'environment',  confidence: 0.85 };
    if (goalKeywords.some(k => message.includes(k)))                   return { type: 'goal_change',  confidence: 0.88 };

    // [Feature 8] Infer intent from short/indirect messages
    if (['okay', 'k', 'cool', 'sure', 'alright'].includes(message))   return { type: 'greeting',     confidence: 0.6 };
    if (message.length < 10 && session.lastIntent)                     return { type: session.lastIntent, confidence: 0.5 };

    return { type: 'general', confidence: 0.5 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 22] INACTIVITY DETECTION
  // ═══════════════════════════════════════════════════════════════════

  private checkInactivity(session: SessionState) {
    if (!session.lastInteractionTime) return null;
    const hoursSince = (Date.now() - session.lastInteractionTime.getTime()) / 3_600_000;
    if (hoursSince > 48) {
      return {
        success: true,
        reply: `Welcome back! It has been ${Math.floor(hoursSince / 24)} days since your last session. Missing workouts happens — the important thing is you are back now. Ready to get moving?`,
        type: 'inactivity_nudge',
        suggestions: ['Generate a quick workout', 'Recovery session first', 'Show my progress']
      };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // DATA FETCHING
  // ═══════════════════════════════════════════════════════════════════

  private async getUserData(userId: string) {
    try {
      const [userProfile, workoutLogs, progressData] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, include: { subscriptions: true } }),
        prisma.workoutLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50, include: { exercise: true } }),
        this.calculateProgressData(userId)
      ]);
      return { userProfile, workoutLogs: workoutLogs || [], progressData };
    } catch (error) {
      logger.warn('AI Coach: Could not fetch user data', error);
      return { userProfile: null, workoutLogs: [], progressData: null };
    }
  }

  private async calculateProgressData(userId: string) {
    try {
      const logs = await prisma.workoutLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
      const totalWorkouts     = logs.length;
      const completedWorkouts = logs.filter(l => l.completed).length;
      const skippedWorkouts   = logs.filter(l => l.skipped).length;
      const consistency       = totalWorkouts > 0 ? (completedWorkouts / totalWorkouts) * 100 : 0;

      let currentStreak = 0;
      const today = new Date();
      for (let i = 0; i < logs.length; i++) {
        const daysDiff = Math.floor((today.getTime() - new Date(logs[i].createdAt).getTime()) / 86_400_000);
        if (daysDiff === currentStreak && logs[i].completed) currentStreak++;
        else break;
      }

      // [Feature 14] weight trend analysis
      const recentWeights = logs.filter(l => (l as any).weight).slice(0, 10).map(l => (l as any).weight as number);
      const weightTrend   = recentWeights.length >= 3
        ? recentWeights[0] < recentWeights[recentWeights.length - 1] ? 'decreasing' : 'increasing'
        : 'stable';

      return {
        totalWorkouts, completedWorkouts, skippedWorkouts,
        consistency, currentStreak,
        lastWorkoutDate: logs[0]?.createdAt || null,
        weightTrend
      };
    } catch { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 18+3] GREETING HANDLER — time-aware, personalised, varied
  // ═══════════════════════════════════════════════════════════════════

  private async handleGreeting(
    userId: string, userProfile: any, workoutLogs: any[],
    progressData: any, context: CoachContext, session: SessionState
  ) {
    const streak = progressData?.currentStreak || 0;
    const name   = userProfile?.name ? `, ${userProfile.name}` : '';

    // [Feature 18] Time-aware greeting
    const timeGreetings: Record<string, string[]> = {
      morning:   [
        `Good morning${name}! Ready to start strong today? 💪`,
        `Morning${name}! Let us build on that ${streak}-day streak!`,
        `Rise and grind${name}! The best workouts happen before excuses do.`
      ],
      afternoon: [
        `Hey${name}! Let's keep your momentum going this afternoon.`,
        `Good afternoon${name}! Mid-day energy — let's channel it into gains.`,
        `Afternoon${name}! A midday workout? That takes discipline. Let's go.`
      ],
      evening:   [
        `Great job showing up tonight${name}. Let's make it count.`,
        `Evening${name}! Perfect time to unwind AND strengthen. Ready?`,
        `Good evening${name}. Training in the evening builds serious consistency.`
      ],
      night:     [
        `Late session${name}? Let's keep it light and effective — nothing too intense.`,
        `Night owl mode${name}. I will suggest something that will not disrupt your sleep.`,
        `Hey${name}! Even a short session beats nothing. Let's keep it smart and brief.`
      ]
    };

    const tod = context.timeOfDay || 'morning';
    const variants = timeGreetings[tod];

    // [Feature 9] Avoid repeating same greeting — rotate via index
    const idx = session.greetingVariantIndex % variants.length;
    session.greetingVariantIndex++;

    const lastWorkout = workoutLogs[0];
    let suffix = '';
    if (lastWorkout && streak > 0) {
      suffix = ` You are on a ${streak}-day streak — keep it going!`;
    } else if (!lastWorkout) {
      suffix = ` It looks like this might be your first session. Let's start you off right!`;
    }

    return {
      success: true,
      reply: variants[idx] + suffix,
      type: 'greeting',
      suggestions: ["Generate today's workout", 'Check my progress', 'I need motivation', 'I have limited time']
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 7+20] WORKOUT REQUEST HANDLER — periodized + diet-coupled
  // ═══════════════════════════════════════════════════════════════════

  private async handleWorkoutRequest(
    userId: string, userProfile: any, workoutLogs: any[], progressData: any,
    context: CoachContext, intent: any, session: SessionState
  ) {
    const fitnessLevel  = this.detectFitnessLevel(workoutLogs);
    const goal          = userProfile?.fitnessGoal || 'general_fitness';
    const availableTime = context.availableTime || 45;
    const equipment     = context.equipment || ['bodyweight'];

    // [Feature 7] Detect periodization phase
    const phase = this.detectPeriodizationPhase(workoutLogs, progressData);

    // [Feature 7] Avoid recently performed exercises (rotation)
    const recentExercises = workoutLogs.slice(0, 3).flatMap((l: any) => l.exercise?.name ? [l.exercise.name] : []);
    const disliked = session.dislikedExercises;

    const workout = this.generateWorkout({
      fitnessLevel, goal, availableTime, equipment,
      recentLogs: workoutLogs.slice(0, 7),
      context, recentExercises, disliked, phase
    });

    // [Feature 20] Attach diet suggestion to every workout
    workout.dietSuggestion = this.getWorkoutDietCoupling(goal, context.timeOfDay || 'morning', availableTime);

    session.lastWorkoutType = workout.type;

    return {
      success: true,
      reply: `Here is your personalised ${availableTime}-minute ${goal.replace(/_/g, ' ')} workout (${phase} phase):`,
      type: 'workout_plan',
      workout,
      suggestions: ['Need modifications?', 'Explain the exercises', 'Make it easier', 'Make it harder']
    };
  }

  // [Feature 7] Periodization phase detection
  private detectPeriodizationPhase(logs: any[], progressData: any): string {
    const total = logs.length;
    if (total < 12)  return 'Foundation';
    if (total < 30)  return 'Accumulation';
    if (total < 60)  return 'Intensification';
    if (total < 90)  return 'Peaking';
    return 'Maintenance / Deload';
  }

  // [Feature 20] Diet coupled to every workout
  private getWorkoutDietCoupling(goal: string, timeOfDay: string, duration: number): string {
    const isHigh = duration > 45;
    const preMap: Record<string, string> = {
      fat_loss:       'Pre-workout: banana + black coffee. Post-workout: 30g protein shake + salad.',
      muscle_gain:    'Pre-workout: oats + banana + protein. Post-workout: rice + chicken or protein shake.',
      endurance:      'Pre-workout: carb-rich meal (rice, pasta) 2 hours before. Post-workout: electrolytes + carbs.',
      general_fitness:'Pre-workout: light snack. Post-workout: protein + complex carbs within 45 minutes.',
    };
    const base = preMap[goal] || preMap.general_fitness;
    const hydration = isHigh ? ' Drink at least 750ml water during the session.' : ' Drink 500ml water during the session.';
    return base + hydration;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WORKOUT GENERATION ENGINE
  // ═══════════════════════════════════════════════════════════════════

  private generateWorkout(params: {
    fitnessLevel: string; goal: string; availableTime: number;
    equipment: string[]; recentLogs: any[]; context: CoachContext;
    recentExercises?: string[]; disliked?: string[]; phase?: string;
  }): WorkoutPlan {
    const { fitnessLevel, goal, availableTime, equipment, context, phase } = params;
    const recentExercises = params.recentExercises || [];
    const disliked        = params.disliked || [];

    let workoutType = '';
    let exercises: Exercise[] = [];

    // [Feature 13] Environment-aware workout selection
    const env = context.environment;
    if (env === 'travel' || env === 'limited_space') {
      workoutType = 'Travel / Small Space Bodyweight';
      exercises   = this.generateTravelWorkout(fitnessLevel, availableTime);
    } else if (goal === 'fat_loss') {
      workoutType = 'HIIT Fat Burn';
      exercises   = this.generateHIITWorkout(fitnessLevel, availableTime, equipment);
    } else if (goal === 'muscle_gain') {
      workoutType = 'Strength & Hypertrophy';
      exercises   = this.generateStrengthWorkout(fitnessLevel, availableTime, equipment);
    } else if (goal === 'endurance') {
      workoutType = 'Endurance Circuit';
      exercises   = this.generateEnduranceWorkout(fitnessLevel, availableTime, equipment);
    } else if (goal === 'mobility') {
      workoutType = 'Mobility & Flexibility';
      exercises   = this.generateMobilityWorkout(fitnessLevel, availableTime);
    } else {
      workoutType = 'Full Body Conditioning';
      exercises   = this.generateFullBodyWorkout(fitnessLevel, availableTime, equipment);
    }

    // [Feature 7] Rotate exercises — skip recently done and disliked
    exercises = exercises.filter(ex => !recentExercises.includes(ex.name) && !disliked.includes(ex.name));
    if (exercises.length < 3) exercises = this.generateFullBodyWorkout(fitnessLevel, availableTime, equipment);

    // [Feature 7] Apply tempo variations (intermediate+)
    if (fitnessLevel !== 'beginner') {
      exercises = exercises.map(ex => ({ ...ex, tempoNotes: '3-1-2 tempo (3s down, 1s pause, 2s up)' }));
    }

    return {
      type: workoutType,
      duration: availableTime,
      warmup:    this.generateWarmup(5),
      exercises,
      cooldown:  this.generateCooldown(5),
      notes:     this.generateWorkoutNotes(fitnessLevel, goal),
      periodPhase: phase
    };
  }

  private generateHIITWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    const all: Exercise[] = [
      { name: 'Jumping Jacks',     sets: 4, reps: '30 sec', rest: 15, intensity: 'high',     formTips: ['Land softly', 'Keep core engaged'] },
      { name: 'Burpees',           sets: 4, reps: '20 sec', rest: 20, intensity: 'high',     formTips: ['Full plank position', 'Explosive jump'] },
      { name: 'Mountain Climbers', sets: 4, reps: '30 sec', rest: 15, intensity: 'high',     formTips: ['Drive knees to chest', 'Maintain plank'] },
      { name: 'High Knees',        sets: 4, reps: '30 sec', rest: 15, intensity: 'high',     formTips: ['Pump arms', 'Lift knees to hip level'] },
      { name: 'Jump Squats',       sets: 3, reps: '20 sec', rest: 20, intensity: 'high',     formTips: ['Soft landing', 'Full squat depth'] },
      { name: 'Speed Skaters',     sets: 3, reps: '30 sec', rest: 15, intensity: 'high',     formTips: ['Wide lateral bound', 'Touch ground lightly'] },
    ];
    if (level === 'beginner') {
      all.forEach(ex => { ex.sets = 3; ex.rest = 30; ex.modifications = ['Take breaks as needed', 'Low-impact version available']; });
    }
    return all.slice(0, Math.max(4, Math.floor(time / 6)));
  }

  private generateStrengthWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    const rL = level === 'beginner' ? 8  : level === 'intermediate' ? 12 : 15;
    const rH = level === 'beginner' ? 10 : level === 'intermediate' ? 15 : 20;
    return [
      { name: 'Push-ups',      sets: 4, reps: rL, rest: 60,  intensity: 'high',     formTips: ['Elbows at 45°', 'Core tight', 'Full range'] },
      { name: 'Squats',        sets: 4, reps: rH, rest: 60,  intensity: 'high',     formTips: ['Chest up', 'Knees track toes', 'Full depth'] },
      { name: 'Plank',         sets: 3, reps: level === 'beginner' ? '30 sec' : level === 'intermediate' ? '45 sec' : '60 sec', rest: 45, intensity: 'moderate', formTips: ['Straight line', 'Squeeze glutes', 'Breathe steadily'] },
      { name: 'Lunges',        sets: 3, reps: `${level === 'beginner' ? 8 : level === 'intermediate' ? 12 : 15} each leg`, rest: 60, intensity: 'moderate', formTips: ['90° angles', 'Vertical torso', 'Control descent'] },
      { name: 'Glute Bridges', sets: 3, reps: rH, rest: 45,  intensity: 'moderate', formTips: ['Drive hips high', 'Squeeze at top', 'Slow descent'] },
      { name: 'Pike Push-ups', sets: 3, reps: rL, rest: 60,  intensity: 'moderate', formTips: ['Hips high', 'Lower head toward floor', 'Core tight'] },
    ];
  }

  private generateEnduranceWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    return [
      { name: 'Running in Place',       sets: 3, reps: '2 min',          rest: 30, intensity: 'moderate', formTips: ['Light on feet', 'Steady pace'] },
      { name: 'Jump Rope (mimicked)',   sets: 3, reps: '1 min',           rest: 30, intensity: 'high',     formTips: ['Stay on toes', 'Consistent rhythm'] },
      { name: 'Step-Ups',               sets: 3, reps: '15 each leg',     rest: 45, intensity: 'moderate', formTips: ['Drive through heel', 'Control the step'] },
      { name: 'Bicycle Crunches',       sets: 3, reps: '20 each side',    rest: 30, intensity: 'moderate', formTips: ['Twist fully', 'Slow and controlled'] },
      { name: 'Bear Crawl',             sets: 3, reps: '30 sec',          rest: 30, intensity: 'moderate', formTips: ['Low hips', 'Opposite hand-foot'] },
    ];
  }

  private generateMobilityWorkout(level: string, time: number): Exercise[] {
    return [
      { name: 'Cat-Cow Stretch',          sets: 2, reps: '10 reps',              rest: 30, intensity: 'low', formTips: ['Slow movements', 'Breathe with each rep'] },
      { name: "World's Greatest Stretch", sets: 2, reps: '5 each side',          rest: 30, intensity: 'low', formTips: ['Hold each position 2 sec', 'Deep breaths'] },
      { name: 'Shoulder Circles',         sets: 2, reps: '15 each direction',    rest: 20, intensity: 'low', formTips: ['Full range', 'Controlled'] },
      { name: 'Hip Circles',              sets: 2, reps: '10 each direction',    rest: 20, intensity: 'low', formTips: ['Large circles', 'Stable core'] },
      { name: 'Pigeon Pose',              sets: 2, reps: '45 sec each side',     rest: 20, intensity: 'low', formTips: ['Ease into stretch', 'Breathe through it'] },
      { name: 'Thoracic Rotation',        sets: 2, reps: '10 each side',         rest: 20, intensity: 'low', formTips: ['Keep hips stable', 'Follow hand with eyes'] },
    ];
  }

  private generateFullBodyWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    return [
      { name: 'Push-ups',         sets: 3, reps: 12,       rest: 60, intensity: 'moderate', formTips: ['Core engaged', 'Full range'] },
      { name: 'Squats',           sets: 3, reps: 15,       rest: 60, intensity: 'moderate', formTips: ['Full depth', 'Chest up'] },
      { name: 'Plank',            sets: 3, reps: '45 sec', rest: 45, intensity: 'moderate', formTips: ['Straight line', 'Breathe'] },
      { name: 'Glute Bridges',    sets: 3, reps: 15,       rest: 45, intensity: 'moderate', formTips: ['Squeeze at top', 'Controlled descent'] },
      { name: 'Mountain Climbers',sets: 3, reps: '30 sec', rest: 30, intensity: 'high',     formTips: ['Fast pace', 'Solid plank'] },
      { name: 'Side Plank',       sets: 2, reps: '30 sec each side', rest: 30, intensity: 'moderate', formTips: ['Stack feet', 'Raise hips'] },
    ];
  }

  // [Feature 13] Travel / limited-space workout
  private generateTravelWorkout(level: string, time: number): Exercise[] {
    return [
      { name: 'Push-ups',           sets: 3, reps: 12, rest: 45, intensity: 'moderate', formTips: ['Use floor space only'] },
      { name: 'Reverse Lunges',     sets: 3, reps: '10 each leg', rest: 45, intensity: 'moderate', formTips: ['Step back, not forward — less floor needed'] },
      { name: 'Bear Plank Hold',    sets: 3, reps: '30 sec', rest: 30, intensity: 'moderate', formTips: ['Knees 2 inches off floor', 'Neutral spine'] },
      { name: 'Seated Core Twists', sets: 3, reps: '20 each side', rest: 30, intensity: 'low', formTips: ['Sit on floor or bed edge'] },
      { name: 'Wall Sit',           sets: 3, reps: '40 sec', rest: 30, intensity: 'moderate', formTips: ['90° knees', 'Arms resting on thighs'] },
    ];
  }

  private generateInjurySafeWorkout(bodyPart: string, userProfile: any, logs: any[], context: CoachContext): WorkoutPlan {
    const level = this.detectFitnessLevel(logs);
    const injuryExerciseMap: Record<string, Exercise[]> = {
      wrist: [
        { name: 'Forearm Plank',     sets: 3, reps: '40 sec',        rest: 30, intensity: 'moderate', formTips: ['No wrist pressure'] },
        { name: 'Wall Sits',         sets: 3, reps: '45 sec',        rest: 30, intensity: 'moderate', formTips: ['Back flat to wall'] },
        { name: 'Glute Bridges',     sets: 3, reps: 15,              rest: 30, intensity: 'moderate', formTips: ['Drive hips upward'] },
        { name: 'Leg Raises',        sets: 3, reps: 12,              rest: 30, intensity: 'moderate', formTips: ['Lower back pressed down'] },
        { name: 'Standing Calf Raises', sets: 3, reps: 20,           rest: 20, intensity: 'low',      formTips: ['Full range'] },
      ],
      knee: [
        { name: 'Dead Bugs',         sets: 3, reps: '10 each side',  rest: 30, intensity: 'moderate', formTips: ['Lower back flat to floor'] },
        { name: 'Glute Bridges',     sets: 3, reps: 15,              rest: 30, intensity: 'moderate', formTips: ['Avoid knee stress'] },
        { name: 'Seated Core Holds', sets: 3, reps: '30 sec',        rest: 20, intensity: 'low',      formTips: ['Control breathing'] },
        { name: 'Push-ups',          sets: 3, reps: 10,              rest: 45, intensity: 'moderate', formTips: ['Upper body focus'] },
        { name: 'Plank',             sets: 3, reps: '40 sec',        rest: 30, intensity: 'moderate', formTips: ['Core engagement'] },
      ],
      shoulder: [
        { name: 'Squats',            sets: 3, reps: 15,              rest: 45, intensity: 'moderate', formTips: ['Keep arms relaxed at sides'] },
        { name: 'Glute Bridges',     sets: 3, reps: 15,              rest: 30, intensity: 'moderate', formTips: ['Arms flat on floor for balance'] },
        { name: 'Leg Raises',        sets: 3, reps: 12,              rest: 30, intensity: 'moderate', formTips: ['Hands loosely at sides'] },
        { name: 'Calf Raises',       sets: 3, reps: 20,              rest: 20, intensity: 'low',      formTips: ['Hold a chair for light balance support'] },
        { name: 'Seated Bicycle Crunches', sets: 3, reps: '15 each side', rest: 30, intensity: 'moderate', formTips: ['No shoulder tension'] },
      ],
    };
    const exercises = injuryExerciseMap[bodyPart] || this.generateFullBodyWorkout(level, 30, ['bodyweight']);
    return { type: `${bodyPart}-safe workout`, duration: 30, warmup: this.generateWarmup(5), exercises, cooldown: this.generateCooldown(5), notes: [`Avoids all exercises that stress the ${bodyPart}`, 'Stop if pain increases'] };
  }

  private generateLightWorkout(userProfile: any, logs: any[], context: CoachContext): WorkoutPlan {
    return {
      type: 'Active Recovery',
      duration: 25,
      warmup:    this.generateWarmup(3),
      exercises: [
        { name: 'Easy Walk in Place', sets: 1, reps: '5 min', rest: 0, intensity: 'low', formTips: ['Slow and relaxed'] },
        { name: 'Gentle Squats',      sets: 2, reps: 10,      rest: 45, intensity: 'low', formTips: ['Slow tempo', 'No bouncing'] },
        { name: 'Cat-Cow',            sets: 2, reps: '8 reps', rest: 30, intensity: 'low', formTips: ['Breathe deeply'] },
        { name: 'Plank',              sets: 2, reps: '20 sec', rest: 30, intensity: 'low', formTips: ['Light hold, do not strain'] },
        { name: 'Deep Stretching',    sets: 1, reps: '5 min', rest: 0,  intensity: 'low', formTips: ['Hold each stretch 30 sec'] },
      ],
      cooldown: this.generateCooldown(5),
      notes: ['Volume reduced 30% from your normal session', 'Focus on breathing and movement quality', 'Rest is part of training']
    };
  }

  private generateWarmup(duration: number): Exercise[] {
    return [
      { name: 'Arm Circles',        sets: 1, reps: '15 each direction', rest: 0, intensity: 'low', formTips: ['Large circles', 'Loose shoulders'] },
      { name: 'Leg Swings',         sets: 1, reps: '10 each leg',       rest: 0, intensity: 'low', formTips: ['Controlled swing', 'Use wall for balance'] },
      { name: 'Bodyweight Squats',  sets: 1, reps: 10,                  rest: 0, intensity: 'low', formTips: ['Gentle', 'Full range'] },
      { name: 'Inchworms',          sets: 1, reps: 5,                   rest: 0, intensity: 'low', formTips: ['Slow', 'Stretch hamstrings fully'] },
    ];
  }

  private generateCooldown(duration: number): Exercise[] {
    return [
      { name: 'Standing Quad Stretch', sets: 1, reps: '30 sec each leg', rest: 0, intensity: 'low', formTips: ['Balance on one foot', 'Gentle pull'] },
      { name: 'Hamstring Stretch',     sets: 1, reps: '30 sec each leg', rest: 0, intensity: 'low', formTips: ['Straight leg', 'Reach forward'] },
      { name: 'Shoulder Stretch',      sets: 1, reps: '30 sec each arm', rest: 0, intensity: 'low', formTips: ['Pull across chest', 'Relax shoulder down'] },
      { name: 'Deep Breathing',        sets: 1, reps: '10 breaths',      rest: 0, intensity: 'low', formTips: ['4-7-8 pattern', 'Heart rate down'] },
    ];
  }

  private generateWorkoutNotes(level: string, goal: string): string[] {
    const notes = [
      `Tailored for your ${level} fitness level`,
      'Form over speed — quality reps count more than rushed ones',
      'Stay hydrated throughout your session',
      'Listen to your body — modify or rest if needed'
    ];
    if (goal === 'fat_loss')    notes.push('Minimise rest between sets for maximum calorie burn');
    if (goal === 'muscle_gain') notes.push('Controlled tempo and full range of motion drives hypertrophy');
    if (goal === 'endurance')   notes.push('Maintain steady breathing rhythm throughout');
    return notes;
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORM & TECHNIQUE HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleFormTechnique(message: string, context: CoachContext, logs: any[]) {
    const exercise = context.currentExercise || this.extractExerciseName(message) || 'this exercise';
    const guide    = this.getFormGuide(exercise);
    return {
      success: true,
      reply: `Perfect form for ${exercise}:\n\n${guide.description}\n\n**Key Points:**\n${guide.keyPoints.join('\n')}\n\n**Common Mistakes:**\n${guide.commonMistakes.join('\n')}\n\n**Breathing:** ${guide.breathing}`,
      type: 'form_tip',
      exercise,
      videoDemo: guide.videoUrl
    };
  }

  private getFormGuide(exercise: string) {
    const guides: Record<string, any> = {
      'push-up': {
        description: 'A fundamental upper body exercise targeting chest, shoulders, and triceps.',
        keyPoints: [
          '• Hands shoulder-width apart, fingers pointing forward',
          '• Core engaged — straight line from head to heels',
          '• Elbows at 45° angle to body',
          '• Lower chest to ground, keeping elbows tucked',
          '• Push through palms to return to start'
        ],
        commonMistakes: ['❌ Sagging hips (engage core!)', '❌ Flaring elbows wide (keep at 45°)', '❌ Partial range of motion', '❌ Looking up (neutral neck)'],
        breathing: 'Inhale on the way down, exhale as you push up',
        videoUrl: null
      },
      'squat': {
        description: 'King of lower body exercises — targets quads, glutes, hamstrings, and core.',
        keyPoints: [
          '• Feet hip to shoulder-width apart, toes slightly out',
          '• Chest up, core braced',
          '• Sit back into hips while keeping chest proud',
          '• Knees track over toes',
          '• Descend until thighs parallel or deeper',
          '• Drive through heels to stand'
        ],
        commonMistakes: ['❌ Knees caving inward', '❌ Heels lifting off ground', '❌ Forward lean', '❌ Shallow depth'],
        breathing: 'Inhale at the top, brace, descend, exhale driving up',
        videoUrl: null
      },
      'plank': {
        description: 'Core stability exercise that strengthens the entire midsection.',
        keyPoints: [
          '• Forearms on ground, elbows under shoulders',
          '• Body in straight line — head to heels',
          '• Squeeze glutes hard',
          '• Engage abs as if bracing for a punch',
          '• Look at ground between hands'
        ],
        commonMistakes: ['❌ Hips sagging (squeeze glutes!)', '❌ Hips too high', '❌ Holding breath', '❌ Looking forward'],
        breathing: 'Breathe normally throughout — do not hold breath',
        videoUrl: null
      },
      'lunge': {
        description: 'Unilateral lower body exercise building balance, strength, and coordination.',
        keyPoints: [
          '• Step forward with control',
          '• Both knees at 90° at the bottom',
          '• Front knee stays over ankle — never past toes',
          '• Torso upright throughout',
          '• Push through front heel to return'
        ],
        commonMistakes: ['❌ Knee past toes', '❌ Leaning forward', '❌ Back knee slamming the floor', '❌ Narrow stance (balance issue)'],
        breathing: 'Inhale stepping down, exhale stepping up',
        videoUrl: null
      },
      'burpee': {
        description: 'Full-body compound movement combining push-up, squat, and jump.',
        keyPoints: [
          '• Start standing, drop hands to floor',
          '• Jump or step feet back to plank',
          '• Lower chest to floor',
          '• Push up, jump feet to hands',
          '• Explode upward into jump with arms overhead'
        ],
        commonMistakes: ['❌ Sagging back in plank', '❌ No push-up (shortcuts)', '❌ Crash landing', '❌ No hip extension at top'],
        breathing: 'Exhale on the jump, controlled inhale on descent',
        videoUrl: null
      },
      'deadlift': {
        description: 'Fundamental hip-hinge — builds posterior chain strength (back, glutes, hamstrings).',
        keyPoints: [
          '• Hip-width stance, bar over mid-foot',
          '• Hinge at hips, reach bar with flat back',
          '• Chest up, lats engaged (protect lower back)',
          '• Drive floor away, keep bar close to body',
          '• Lock out hips and knees at top simultaneously'
        ],
        commonMistakes: ['❌ Rounding lower back', '❌ Bar drifting away from body', '❌ Jerking off the floor', '❌ Knees caving'],
        breathing: 'Deep breath in before lift, exhale at lockout',
        videoUrl: null
      },
    };
    const key = exercise.toLowerCase().replace('-up', '-up').replace(/s$/, '').trim();
    for (const k of Object.keys(guides)) {
      if (key.includes(k) || k.includes(key)) return guides[k];
    }
    return {
      description: `${exercise} — here is how to perform it correctly:`,
      keyPoints:   ['• Maintain proper posture', '• Move with control', '• Full range of motion', '• Keep core engaged'],
      commonMistakes: ['❌ Using momentum', '❌ Partial range', '❌ Poor posture', '❌ Holding breath'],
      breathing: 'Exhale on effort (concentric), inhale on return (eccentric)',
      videoUrl: null
    };
  }

  private extractExerciseName(message: string): string | null {
    const exercises = ['push-up', 'squat', 'plank', 'lunge', 'burpee', 'pull-up', 'deadlift', 'row', 'crunch', 'dip', 'curl'];
    for (const ex of exercises) {
      if (message.includes(ex)) return ex;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 4] INJURY & PAIN HANDLER — severity classification + escalation
  // ═══════════════════════════════════════════════════════════════════

  private handleInjuryPain(
    message: string, context: CoachContext,
    userProfile: any, logs: any[], session: SessionState
  ) {
    const bodyPart = this.extractBodyPart(message);
    const severity = this.classifyInjurySeverity(message);

    // [Feature 4] Track injury history
    if (bodyPart) {
      session.injuryHistory.push({ bodyPart, severity, reportedAt: new Date(), resolved: false });
      session.lastInjury = bodyPart;
    }

    // [Feature 4] Escalate serious cases
    if (severity === 'severe') {
      return {
        success: true,
        reply: `⚠️ The severity of what you are describing is serious. I strongly recommend stopping activity immediately and consulting a doctor or physiotherapist before continuing training. Your long-term health matters more than any workout.`,
        type: 'safety_escalation',
        suggestions: ['Rest completely today', 'Recovery nutrition tips', 'When can I train again?']
      };
    }

    const alternatives = this.getSafeAlternatives(context.currentExercise || this.extractExerciseName(message), bodyPart);

    // [Feature 2] Set pending action — wait for user confirmation
    session.pendingAction = {
      type: 'injury_workout',
      data: { bodyPart, alternatives },
      prompt: `Shall I generate a ${bodyPart || 'injury'}-safe workout for today?`,
      timestamp: new Date()
    };

    const severityNote = severity === 'moderate'
      ? '\n\n⚠️ This seems moderate. If pain persists over 3 days, see a healthcare professional.'
      : '\n\n💡 If this is an ongoing issue, consider getting it assessed professionally.';

    return {
      success: true,
      reply: `I understand you are experiencing discomfort${bodyPart ? ` in your ${bodyPart}` : ''}. Your safety is the priority.\n\n**Safe Alternatives:**\n${alternatives.map((a, i) => `${i + 1}. ${a.name} — ${a.reason}`).join('\n')}${severityNote}\n\nShall I generate a ${bodyPart || 'injury'}-safe workout for today?`,
      type: 'injury_modification',
      alternatives,
      bodyPart,
      severity,
      awaitingConfirmation: true
    };
  }

  private classifyInjurySeverity(message: string): 'mild' | 'moderate' | 'severe' {
    const severe   = ['sharp pain', 'can\'t move', 'swollen', 'can\'t walk', 'popped', 'snapped', 'extreme', 'unbearable'];
    const moderate = ['moderate', 'aching', 'quite sore', 'pretty bad', 'significant', 'throbbing'];
    if (severe.some(k   => message.includes(k))) return 'severe';
    if (moderate.some(k => message.includes(k))) return 'moderate';
    return 'mild';
  }

  private extractBodyPart(message: string): string | null {
    const parts = ['wrist', 'elbow', 'shoulder', 'back', 'lower back', 'knee', 'ankle', 'hip', 'neck', 'hamstring', 'quad', 'calf', 'foot', 'shin'];
    for (const part of parts) {
      if (message.includes(part)) return part;
    }
    return null;
  }

  private getSafeAlternatives(exercise: string | null, bodyPart: string | null) {
    const map: Record<string, { name: string; reason: string }[]> = {
      wrist:    [{ name: 'Forearm Plank', reason: 'No wrist pressure' }, { name: 'Wall Push-ups', reason: 'Reduced wrist load' }, { name: 'Resistance Band Rows', reason: 'Wrist-neutral pulling movement' }],
      knee:     [{ name: 'Wall Sits', reason: 'Static hold, low joint stress' }, { name: 'Glute Bridges', reason: 'Strengthens without deep knee flexion' }, { name: 'Swimming / Cycling', reason: 'Low-impact cardio' }],
      shoulder: [{ name: 'Knee Push-ups', reason: 'Reduced shoulder load' }, { name: 'Band Pull-aparts', reason: 'Shoulder-friendly pulling' }, { name: 'Dead Bugs', reason: 'Core without shoulder stress' }],
      back:     [{ name: 'Dead Bugs', reason: 'Stabilises spine safely' }, { name: 'Gentle Cat-Cow', reason: 'Spinal mobility without load' }, { name: 'Walking', reason: 'Low impact, maintains activity' }],
      ankle:    [{ name: 'Seated Upper Body Work', reason: 'No ankle load' }, { name: 'Chair Squats', reason: 'Supported, reduced ankle stress' }, { name: 'Arm Circles / Upper Cardio', reason: 'Maintains HR without ankle' }],
      hip:      [{ name: 'Seated Core Work', reason: 'No hip flexion under load' }, { name: 'Upper Body Push-ups', reason: 'Minimal hip engagement' }, { name: 'Gentle Hip Circles', reason: 'Mobility without loading' }],
    };
    return map[bodyPart || ''] || [
      { name: 'Reduced Range of Motion', reason: 'Work within pain-free zone' },
      { name: 'Lighter Resistance', reason: 'Reduce load on affected area' },
      { name: 'Isometric Holds', reason: 'Build strength without movement' }
    ];
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 10] MOTIVATION HANDLER — data-driven, personalised
  // ═══════════════════════════════════════════════════════════════════

  private async handleMotivation(
    userId: string, userProfile: any, logs: any[],
    progressData: any, session: SessionState
  ) {
    const streak       = progressData?.currentStreak || 0;
    const totalWorkouts= progressData?.totalWorkouts || 0;
    const consistency  = progressData?.consistency || 0;
    const name         = userProfile?.name || 'champ';

    // [Feature 10] Behavioral scoring nudge
    session.behaviorScore = Math.min(100, session.behaviorScore + 5);

    const messages = [
      `You have logged ${totalWorkouts} workouts, ${name}. That is ${totalWorkouts * 45} minutes of pure dedication. Every rep counts. 💪`,
      `${streak}-day streak! You are not just training your body — you are building unshakeable discipline.`,
      `You are ${consistency.toFixed(0)}% consistent. That places you ahead of 90% of people who ever started a fitness journey.`,
      `The hardest part is showing up. You have done that ${totalWorkouts} times. One more session. You have got this.`,
      `Struggle builds strength. Every workout is progress, even on the days it does not feel like it.`,
      `Real results live in the quiet reps nobody sees. You are building something real, ${name}.`,
    ];

    const message = messages[Math.floor(Math.random() * messages.length)];

    return {
      success: true,
      reply: message,
      type: 'motivation',
      stats: { streak, totalWorkouts, consistency: `${consistency.toFixed(0)}%`, behaviorScore: session.behaviorScore },
      suggestions: ['Show me my progress', 'Set a new goal', 'I want to workout now']
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 14+6] PROGRESS CHECK — predictive + diet adaptation
  // ═══════════════════════════════════════════════════════════════════

  private async handleProgressCheck(userId: string, logs: any[], progressData: any, session: SessionState) {
    const weeklyWorkouts = this.getWeeklyWorkouts(logs);
    const improvements   = this.detectImprovements(logs);
    const prediction     = this.predictNextMilestone(logs);
    const plateau        = this.detectPlateau(logs);
    const weightTrend    = (progressData as any)?.weightTrend || 'stable';
    const dietAdaptation = this.getDietAdaptationFromProgress(weightTrend, progressData);

    return {
      success: true,
      reply: `📊 **Your Progress Report**\n\n**This Week:** ${weeklyWorkouts} workouts\n**Streak:** ${progressData?.currentStreak || 0} days\n**Consistency:** ${progressData?.consistency?.toFixed(0) || 0}%\n**Total Workouts:** ${progressData?.totalWorkouts || 0}\n\n${improvements.length ? `🎯 **Recent Improvements:**\n${improvements.join('\n')}\n\n` : ''}${plateau ? `⚠️ **Plateau Detected:** ${plateau}\n\n` : ''}${prediction}\n\n💡 **Diet Adjustment:** ${dietAdaptation}`,
      type: 'progress_report',
      data: { weeklyWorkouts, streak: progressData?.currentStreak, consistency: progressData?.consistency, improvements, weightTrend }
    };
  }

  // [Feature 14] Plateau detection
  private detectPlateau(logs: any[]): string | null {
    if (logs.length < 20) return null;
    const recentSets = logs.slice(0, 10).reduce((s, l) => s + (l.sets || 0), 0);
    const olderSets  = logs.slice(10, 20).reduce((s, l) => s + (l.sets || 0), 0);
    if (Math.abs(recentSets - olderSets) < 2) {
      return 'Your volume has not changed in the last 2 weeks. Consider progressive overload — add 1 set, 1 rep, or a new exercise.';
    }
    return null;
  }

  // [Feature 6] Diet adaptation from progress data
  private getDietAdaptationFromProgress(userProfile: any, weightTrend: string, progressData: any): string {
    type FitnessGoal = 'general_fitness' | 'fat_loss' | 'muscle_gain';
    const goal: FitnessGoal = userProfile?.fitnessGoal || 'general_fitness';
    if (weightTrend === 'increasing' && goal === 'fat_loss') return 'Weight trending up. Consider reducing carbs by 50–100 calories on non-training days.';
    if (weightTrend === 'decreasing' && goal === 'muscle_gain') return 'Weight dropping. Increase daily calories by 200 — focus on protein and complex carbs.';
    if ((progressData?.consistency || 0) > 80)                return 'Great consistency! Consider a refeed day this week — slightly higher calories to avoid metabolic adaptation.';
    return 'Maintain current diet. Focus on meal timing — eat protein within 45 minutes of training.';
  }

  private getWeeklyWorkouts(logs: any[]): number {
    const oneWeekAgo = new Date(Date.now() - 7 * 86_400_000);
    return logs.filter(l => new Date(l.createdAt) >= oneWeekAgo && l.completed).length;
  }

  private detectImprovements(logs: any[]): string[] {
    const improvements: string[] = [];
    if (logs.length >= 10) {
      const recentAvg = logs.slice(0, 5).reduce((s, l) => s + (l.sets || 0), 0) / 5;
      const olderAvg  = logs.slice(5, 10).reduce((s, l) => s + (l.sets || 0), 0) / 5;
      if (recentAvg > olderAvg * 1.1) improvements.push('• 📈 Volume increased by 10%+');
    }
    if (logs.slice(0, 7).every(l => l.completed)) improvements.push('• 🔥 Perfect workout week!');
    return improvements;
  }

  private predictNextMilestone(logs: any[]): string {
    const total = logs.length;
    if (total < 10)  return `🎯 **Next Milestone:** 10 workouts (${10 - total} to go!)`;
    if (total < 25)  return `🎯 **Next Milestone:** 25 workouts (${25 - total} to go!)`;
    if (total < 50)  return `🎯 **Next Milestone:** 50 workouts (${50 - total} to go!)`;
    if (total < 100) return `🎯 **Next Milestone:** 100 workouts (${100 - total} to go!)`;
    return `🎯 You are a fitness veteran with ${total} workouts! Keep setting new records.`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 5+6] NUTRITION HANDLER — dynamic, goal-aligned, data-driven
  // ═══════════════════════════════════════════════════════════════════

  private handleNutrition(userProfile: any, logs: any[], intent: any, progressData: any) {
    const goal        = userProfile?.fitnessGoal || 'general_fitness';
    const weight      = userProfile?.weight || 75;
    const tips        = this.getNutritionTips(goal, weight, progressData);
    const dietAdjust  = this.getDietAdaptationFromProgress((progressData as any)?.weightTrend || 'stable', progressData);

    return {
      success: true,
      reply: `🍎 **Nutrition Plan for ${goal.replace(/_/g, ' ')}:**\n\n${tips.join('\n')}\n\n📊 **Based on your progress:** ${dietAdjust}\n\n⚠️ These are evidence-based guidelines. Consult a registered dietitian for fully personalised advice.`,
      type: 'nutrition_advice',
      goal
    };
  }

  private getNutritionTips(goal: string, weight: number, progressData: any): string[] {
    const protein_low  = Math.round(weight * 1.6);
    const protein_high = Math.round(weight * 2.2);
    const tips: Record<string, string[]> = {
      fat_loss: [
        `🔸 **Calories:** 300–500 below maintenance (approx ${Math.round(weight * 28)}–${Math.round(weight * 31)} kcal/day)`,
        `🔸 **Protein:** ${protein_low}–${protein_high}g/day to preserve lean muscle`,
        `🔸 **Carbs:** Focus on oats, rice, and sweet potato around training`,
        `🔸 **Hydration:** 3–4 litres of water daily`,
        `🔸 **Meal Timing:** Protein within 45 min of training`,
        `🔸 **Avoid:** Liquid calories, processed snacks, skipping meals`,
      ],
      muscle_gain: [
        `🔸 **Calories:** 300–500 above maintenance (approx ${Math.round(weight * 35)}–${Math.round(weight * 38)} kcal/day)`,
        `🔸 **Protein:** ${protein_high}–${Math.round(weight * 2.4)}g/day for muscle synthesis`,
        `🔸 **Carbs:** Rice, oats, pasta — fuel heavy sessions`,
        `🔸 **Post-Workout:** Protein + carbs within 60 minutes`,
        `🔸 **Meal frequency:** Every 3–4 hours to maintain anabolism`,
        `🔸 **Fats:** Avocado, nuts, olive oil for hormone support`,
      ],
      endurance: [
        `🔸 **Carbs:** Primary fuel — prioritise complex carbs daily`,
        `🔸 **Hydration:** Replace fluids lost — weigh in and out of long sessions`,
        `🔸 **Electrolytes:** Sodium, potassium, magnesium — especially for 60+ min sessions`,
        `🔸 **Recovery:** Carbs + protein post-workout for glycogen replenishment`,
        `🔸 **Pre-session:** Eat 2–3 hours before; banana + oats works well`,
      ],
      general_fitness: [
        `🔸 **Balance:** 40% carbs, 30% protein, 30% healthy fats`,
        `🔸 **Protein:** ${protein_low}–${Math.round(weight * 1.8)}g/day`,
        `🔸 **Hydration:** 2–3 litres daily`,
        `🔸 **Vegetables:** Half your plate at every meal`,
        `🔸 **Simple rule:** Eat mostly whole foods, minimise ultra-processed items`,
      ]
    };
    return tips[goal] || tips.general_fitness;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 4] RECOVERY HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleRecovery(userProfile: any, logs: any[], session: SessionState) {
    const freq = logs.slice(0, 7).filter(l => l.completed).length;
    let advice = '';
    if (freq >= 6) {
      advice = 'You have trained 6+ days this week. Your body needs rest to adapt and grow. I strongly recommend a full rest day or active recovery.';
    } else if (freq >= 4) {
      advice = 'Training consistently! Consider an active recovery session today — light cardio, stretching, or yoga.';
    } else {
      advice = 'You have capacity to train more this week. If you are feeling good, let us schedule a session!';
    }

    return {
      success: true,
      reply: `🧘 **Recovery Guidance:**\n\n${advice}\n\n**Active Recovery Ideas:**\n• 20-min walk at easy pace\n• Gentle yoga or full-body stretching\n• Foam rolling (hold tender spots 30–60 sec)\n• Light swimming\n• Mobility flow (hip circles, shoulder rolls)\n\n**Recovery Essentials:**\n• Sleep 7–9 hours\n• Protein intake — muscles repair during rest\n• Stay hydrated\n• Manage stress — cortisol inhibits recovery`,
      type: 'recovery_advice',
      workoutFrequency: freq
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 1+2] FATIGUE HANDLER — with pending action
  // ═══════════════════════════════════════════════════════════════════

  private handleFatigue(userId: string, userProfile: any, logs: any[], context: CoachContext, session: SessionState) {
    session.lastFatigue = context.energyLevel || 3;

    // [Feature 14] Predict if this is chronic fatigue
    const recentFatigueSessions = logs.slice(0, 7).filter(l => (l.fatigue || 0) >= 7).length;
    const isChronicFatigue = recentFatigueSessions >= 3;

    if (isChronicFatigue) {
      session.pendingAction = {
        type: 'deload_confirm',
        data: { logs },
        prompt: 'This looks like overtraining. Want me to schedule a deload week?',
        timestamp: new Date()
      };
      return {
        success: true,
        reply: `Your logs show high fatigue across ${recentFatigueSessions} of your last 7 sessions. This is a sign of accumulated fatigue — not weakness.\n\nChronic fatigue without recovery leads to overtraining syndrome, increased injury risk, and performance drops.\n\nWould you like me to schedule a deload week — 50% volume reduction with active recovery?`,
        type: 'chronic_fatigue_warning',
        awaitingConfirmation: true
      };
    }

    session.pendingAction = {
      type: 'fatigue_adjust',
      data: { originalGoal: userProfile?.fitnessGoal },
      prompt: 'Want me to adjust today\'s workout to be lighter?',
      timestamp: new Date()
    };

    return {
      success: true,
      reply: `Fatigue is real — respect it. Let's adjust:\n\n**Option 1: Lighter Session (30% volume reduction)**\nSame exercises, fewer sets, focus on form\n\n**Option 2: Active Recovery**\nWalking, stretching, or gentle yoga\n\n**Option 3: Full Rest Day**\nYour body rebuilds on rest days — this is valid training\n\nWant me to adjust today's workout to be lighter?`,
      type: 'fatigue_adjustment',
      suggestions: ['Yes, give me a lighter workout', 'Active recovery plan', "I'll rest today", 'Actually I feel better now'],
      awaitingConfirmation: true
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 7] DELOAD HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleDeload(userId: string, userProfile: any, logs: any[], session: SessionState) {
    session.pendingAction = {
      type: 'deload_confirm',
      data: { logs },
      prompt: 'Shall I generate your deload week plan?',
      timestamp: new Date()
    };
    return {
      success: true,
      reply: `A deload week is a strategic reduction in training volume and intensity (typically 40–60% less) to allow full recovery and supercompensation.\n\n**Why deload:**\n• Prevent overtraining syndrome\n• Allow joints and connective tissue to recover\n• Reset motivation\n• Trigger strength gains after recovery\n\n**Deload frequency:** Every 4–6 weeks for intermediate/advanced, every 6–8 for beginners.\n\nShall I generate your deload week plan?`,
      type: 'deload_info',
      awaitingConfirmation: true
    };
  }

  private executeDeload(userProfile: any, logs: any[], context: CoachContext): any {
    return {
      success: true,
      reply: `Here is your deload week plan — same exercises as normal but 50% volume:\n\n• **Sets:** Reduce by half\n• **Intensity:** 60–70% of normal effort\n• **Focus:** Form, breathing, mind-muscle connection\n• **Cardio:** Light walks only\n• **Duration:** 7 days, then resume normal training\n\nYour body will come back stronger. Trust the process.`,
      type: 'deload_plan',
      suggestions: ['Start deload today', 'Nutrition during deload', 'When to return to full training']
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 11] SCHEDULING HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleScheduling(userId: string, userProfile: any, logs: any[], context: CoachContext, session: SessionState) {
    const mins = context.availableTime || 20;

    if (mins < 15) {
      return {
        success: true,
        reply: `Only ${mins} minutes? Here is an ultra-efficient express circuit:\n\n**${mins}-Minute Express:**\n• 2 min: Jumping Jacks + High Knees\n• 1 min: Push-ups (max)\n• 1 min: Squats (max)\n• 1 min: Plank hold\n• Rest 30 sec, repeat once\n\nShort sessions > zero sessions. You showed up — that is the win.`,
        type: 'time_based_workout',
        duration: mins,
        suggestions: ['Log this workout', 'Schedule a full session tonight', 'Weekly schedule tips']
      };
    } else if (mins < 30) {
      return {
        success: true,
        reply: `${mins} minutes is enough for a focused, effective session. I will generate a ${mins}-minute workout targeting your main goal.`,
        type: 'time_based_workout',
        duration: mins,
        suggestions: [`Generate my ${mins}-min workout`, 'Best use of 20 minutes', 'I want to make it harder']
      };
    }

    const weeklySchedule = this.generateWeeklySchedule(userProfile?.fitnessGoal || 'general_fitness', userProfile?.fitnessLevel || 'beginner');
    return {
      success: true,
      reply: `Great — ${mins} minutes allows a complete session. Here is also a suggested weekly schedule for your goal:\n\n${weeklySchedule}`,
      type: 'schedule_plan',
      duration: mins,
      suggestions: ["Generate today's workout", 'Set a reminder', 'Adjust schedule']
    };
  }

  private generateWeeklySchedule(goal: string, level: string): string {
    const schedules: Record<string, string> = {
      fat_loss:       'Mon: HIIT | Tue: Strength | Wed: Active Recovery | Thu: HIIT | Fri: Strength | Sat: Walk/Cardio | Sun: Rest',
      muscle_gain:    'Mon: Push | Tue: Pull | Wed: Legs | Thu: Rest | Fri: Push | Sat: Pull | Sun: Rest',
      endurance:      'Mon: Long Run/Cardio | Tue: Strength | Wed: Easy Cardio | Thu: Intervals | Fri: Strength | Sat: Long Cardio | Sun: Rest',
      general_fitness:'Mon: Full Body | Tue: Cardio | Wed: Rest | Thu: Full Body | Fri: Active Recovery | Sat: Optional | Sun: Rest',
    };
    return schedules[goal] || schedules.general_fitness;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 13] ENVIRONMENT HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleEnvironment(context: CoachContext, userProfile: any, logs: any[], session: SessionState) {
    const env    = context.environment || 'home';
    const noisy  = context.isNoisy;
    const level  = this.detectFitnessLevel(logs);

    const envReplies: Record<string, string> = {
      travel:        'You are travelling — no problem! Here is a hotel-room bodyweight session that needs zero equipment and minimal space.',
      limited_space: 'Limited space? I will keep all exercises within a 2m x 2m area.',
      outdoors:      'Outdoor training is fantastic! I will design a park circuit using benches, grass, and open space.',
      gym:           'Full gym access — let\'s make the most of the equipment available.',
      home:          'Home workout mode — bodyweight and any dumbbells you have.',
    };

    const workout = this.generateWorkout({
      fitnessLevel: level,
      goal: userProfile?.fitnessGoal || 'general_fitness',
      availableTime: context.availableTime || 30,
      equipment: context.equipment || ['bodyweight'],
      recentLogs: logs.slice(0, 5),
      context
    });

    return {
      success: true,
      reply: `${envReplies[env] || envReplies.home}`,
      type: 'environment_workout',
      workout,
      suggestions: ['Start this workout', 'Make it harder', 'I have more time']
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 15] GOAL CHANGE HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleGoalChange(message: string, session: SessionState) {
    const goalMap: Record<string, string> = {
      'fat loss': 'fat_loss', 'lose weight': 'fat_loss', 'cutting': 'fat_loss',
      'muscle': 'muscle_gain', 'bulk': 'muscle_gain', 'gain': 'muscle_gain', 'build': 'muscle_gain',
      'endurance': 'endurance', 'cardio': 'endurance', 'stamina': 'endurance',
      'mobility': 'mobility', 'flexibility': 'mobility', 'stretch': 'mobility',
    };

    let detectedGoal = '';
    for (const [key, val] of Object.entries(goalMap)) {
      if (message.includes(key)) { detectedGoal = val; break; }
    }

    return {
      success: true,
      reply: detectedGoal
        ? `Great choice! Switching to ${detectedGoal.replace(/_/g, ' ')} mode. I will adjust your workouts, nutrition tips, and progress tracking to align with this goal. Update your profile to lock this in permanently.`
        : `What goal would you like to switch to?\n\n• 🔥 Fat Loss — HIIT + calorie deficit\n• 💪 Muscle Gain — Strength training + surplus\n• 🏃 Endurance — Cardio + circuits\n• 🧘 Mobility — Stretching + joint health\n• ⚡ General Fitness — Balanced approach`,
      type: 'goal_change',
      detectedGoal: detectedGoal || null,
      suggestions: ['Fat loss plan', 'Muscle gain plan', 'Endurance plan', 'Mobility plan']
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 12] FEEDBACK HANDLER — RPE + preference learning
  // ═══════════════════════════════════════════════════════════════════

  private handleFeedback(message: string, userProfile: any, logs: any[], session: SessionState) {
    const tooEasy  = /too easy|not hard enough|need more|too light/i.test(message);
    const tooHard  = /too hard|too difficult|couldn't finish|felt bad|struggled|brutal/i.test(message);
    const liked    = /loved|enjoyed|liked|great workout|felt great|felt good|amazing/i.test(message);
    const disliked = /hated|didn\'t like|boring|disliked|not for me/i.test(message);

    if (tooEasy) {
      session.preferredIntensity = 'high';
      session.rpeHistory.push(3);
      return { success: true, reply: 'Great — I will increase intensity and volume in your next session. Consider adding weight, extra sets, or shorter rest periods.', type: 'feedback_applied', adjustment: 'increase_intensity' };
    }
    if (tooHard) {
      session.preferredIntensity = 'moderate';
      session.rpeHistory.push(9);
      return { success: true, reply: 'Noted — reducing intensity for next time. Good effort for pushing through! Recovery today will help.', type: 'feedback_applied', adjustment: 'reduce_intensity' };
    }
    if (liked) {
      session.weeklyFeedback.push({ date: new Date(), rpe: 7, liked: true, workoutType: session.lastWorkoutType || 'unknown' });
      if (session.lastWorkoutType) session.likedExercises.push(session.lastWorkoutType);
      return { success: true, reply: 'Love that! I will keep this style in your rotation and build on it progressively.', type: 'feedback_positive' };
    }
    if (disliked) {
      if (session.lastWorkoutType) session.dislikedExercises.push(session.lastWorkoutType);
      return { success: true, reply: 'Noted — I will remove this workout type from your plan. What would you prefer? Strength, HIIT, endurance, or mobility?', type: 'feedback_negative', suggestions: ['More strength training', 'More HIIT', 'More mobility work', 'Balanced mix'] };
    }

    return { success: true, reply: 'Thanks for the feedback! Knowing how sessions feel helps me personalise your plan more accurately.', type: 'feedback_general' };
  }

  // [Feature 12] Detect RPE feedback in messages
  private detectRPEFeedback(message: string, session: SessionState) {
    const rpeMatch = message.match(/(?:rpe|effort|rating)[^\d]*(\d+)/i) || message.match(/(\d+)\s*(?:out of|\/)\s*10/i);
    if (!rpeMatch) return null;
    const rpe = parseInt(rpeMatch[1]);
    if (rpe < 1 || rpe > 10) return null;
    session.rpeHistory.push(rpe);
    if (session.rpeHistory.length > 10) session.rpeHistory.shift();
    const avgRPE = session.rpeHistory.reduce((a, b) => a + b, 0) / session.rpeHistory.length;
    let adjustment = '';
    if (avgRPE < 5)      adjustment = 'Your average effort is low — increasing intensity next session.';
    else if (avgRPE > 8) adjustment = 'Your average effort is very high — adding a recovery session soon.';
    else                 adjustment = 'Effort level looks well-calibrated. Maintaining current intensity.';
    return { success: true, reply: `RPE ${rpe}/10 logged. ${adjustment}`, type: 'rpe_logged', rpe, avgRPE: avgRPE.toFixed(1) };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 22] DAILY SUMMARY HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleDailySummary(userId: string, logs: any[], progressData: any, context: CoachContext) {
    const todayLogs = logs.filter(l => {
      const lDate = new Date(l.createdAt);
      const now   = new Date();
      return lDate.toDateString() === now.toDateString();
    });

    const totalSets  = todayLogs.reduce((s, l) => s + (l.sets || 0), 0);
    const completed  = todayLogs.filter(l => l.completed).length;
    const streak     = progressData?.currentStreak || 0;

    return {
      success: true,
      reply: `📋 **Today's Summary**\n\n✅ Exercises completed: ${completed}\n💪 Total sets: ${totalSets}\n🔥 Current streak: ${streak} days\n📈 Weekly consistency: ${progressData?.consistency?.toFixed(0) || 0}%\n\n${completed > 0 ? 'Great work today! Rest up, recover, and come back stronger.' : 'No workouts logged today yet. Still time to get a session in!'}`,
      type: 'daily_summary',
      data: { completed, totalSets, streak }
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 10] HABIT NUDGE CHECK
  // ═══════════════════════════════════════════════════════════════════

  private checkHabitNudge(message: string, progressData: any, session: SessionState) {
    // Only fire for very short messages that are not real queries
    if (message.length > 30) return null;
    const streak = progressData?.currentStreak || 0;
    if (streak > 0 && streak % 7 === 0) {
      session.behaviorScore = Math.min(100, session.behaviorScore + 10);
      return {
        success: true,
        reply: `🎉 ${streak}-day streak milestone! That is ${streak / 7} full week${streak > 7 ? 's' : ''} of consistent training. You are building a real habit — this is where lasting change happens.`,
        type: 'streak_milestone',
        streak,
        suggestions: ["Keep going! Today's workout", 'Share my progress', 'Increase my challenge']
      };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [Feature 9] DEFAULT HANDLER — smart fallback
  // ═══════════════════════════════════════════════════════════════════

  private handleDefault(userId: string, userProfile: any, logs: any[], message: string, session: SessionState) {
    const name = userProfile?.name ? `, ${userProfile.name}` : '';
    return {
      success: true,
      reply: `I am here to help${name}. Here is what I can do:\n\n🏋️ **Workout Plans** — personalised to your goal and time\n📊 **Progress Tracking** — streaks, improvements, milestones\n💪 **Motivation** — data-driven encouragement\n🩺 **Form Coaching** — technique and common mistakes\n🍎 **Nutrition Guidance** — goal-aligned eating\n🧘 **Recovery Plans** — rest and mobility\n🔄 **Fatigue Adjustment** — lighter sessions when needed\n⏱️ **Quick Workouts** — 10–15 min express sessions\n🌍 **Travel / Home Workouts** — no gym needed\n\nWhat would you like help with?`,
      type: 'general',
      suggestions: ['Generate a workout', 'Check my progress', 'I need motivation', 'Nutrition tips']
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════

  private detectFitnessLevel(logs: any[]): string {
    if (logs.length < 10) return 'beginner';
    if (logs.length < 50) return 'intermediate';
    return 'advanced';
  }

  private getDefaultSuggestions(): string[] {
    return ['Generate a workout', 'Check my progress', 'I need motivation', 'Nutrition tips'];
  }

  private async calculateStreak(logs: any[]): Promise<number> {
    let streak = 0;
    const today = new Date();
    for (const log of logs) {
      const daysDiff = Math.floor((today.getTime() - new Date(log.createdAt).getTime()) / 86_400_000);
      if (daysDiff === streak && log.completed) streak++;
      else break;
    }
    return streak;
  }

  private getPostWorkoutDiet(goal: string): string {
    const map: Record<string, string> = {
      fat_loss:       'Post-workout: 25–30g protein + vegetables. Avoid high-carb meals for 1–2 hours.',
      muscle_gain:    'Post-workout: 30–40g protein + 60–80g carbs within 45 minutes for maximum muscle protein synthesis.',
      endurance:      'Post-workout: Electrolyte drink + carbs + protein. Prioritise glycogen replenishment.',
      general_fitness:'Post-workout: Balanced meal with protein, carbs, and vegetables within 1 hour.',
    };
    return map[goal] || map.general_fitness;
  }
}

export const aiCoach = new AICoachService();
