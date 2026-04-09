// aiCoach.service.ts - ULTRA-INTELLIGENT AI FITNESS COACH
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════

interface UserProfile {
  id: string;
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
  fatigue?: number; // 1-10 scale
  pain?: number; // 1-10 scale
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
  availableTime?: number; // minutes
  equipment?: string[];
  mood?: string;
  energyLevel?: number; // 1-10
}

interface WorkoutPlan {
  type: string;
  duration: number;
  exercises: Exercise[];
  warmup: Exercise[];
  cooldown: Exercise[];
  notes: string[];
}

interface Exercise {
  name: string;
  sets: number;
  reps: number | string;
  rest: number;
  intensity: 'low' | 'moderate' | 'high';
  modifications?: string[];
  formTips?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// AI COACH SERVICE - MAIN CLASS
// ═══════════════════════════════════════════════════════════════════

export class AICoachService {
  private conversationHistory = new Map<string, ChatMessage[]>();
  private userContext = new Map<string, any>();
  private workoutPreferences = new Map<string, any>();

  // ═══════════════════════════════════════════════════════════════════
  // MAIN ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════

  async getResponse(userId: string, message: string, context: CoachContext) {
    const lower = message.toLowerCase().trim();

    // Update conversation history
    let history = this.conversationHistory.get(userId) || [];
    history.push({ role: 'user', content: message, timestamp: new Date(), context });
    this.conversationHistory.set(userId, history.slice(-20)); // Keep last 20 messages

    // Fetch user data
    const userData = await this.getUserData(userId);
    const { userProfile, workoutLogs, progressData } = userData;

    // Detect user intent
    const intent = this.detectIntent(lower, context);

    // Route to appropriate handler
    switch (intent.type) {
      case 'greeting':
        return this.handleGreeting(userId, userProfile, workoutLogs);
      
      case 'workout_request':
        return this.handleWorkoutRequest(userId, userProfile, workoutLogs, context, intent);
      
      case 'form_technique':
        return this.handleFormTechnique(lower, context, workoutLogs);
      
      case 'injury_pain':
        return this.handleInjuryPain(lower, context, userProfile, workoutLogs);
      
      case 'motivation':
        return this.handleMotivation(userId, userProfile, workoutLogs, progressData);
      
      case 'progress_check':
        return this.handleProgressCheck(userId, workoutLogs, progressData);
      
      case 'nutrition':
        return this.handleNutrition(userProfile, workoutLogs, intent);
      
      case 'recovery':
        return this.handleRecovery(userProfile, workoutLogs);
      
      case 'fatigue':
        return this.handleFatigue(userId, userProfile, workoutLogs, context);
      
      case 'schedule':
        return this.handleScheduling(userId, userProfile, workoutLogs, context);
      
      default:
        return this.handleDefault(userId, userProfile, workoutLogs, lower);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // INTENT DETECTION
  // ═══════════════════════════════════════════════════════════════════

  private detectIntent(message: string, context: CoachContext) {
    const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'what\'s up', 'sup'];
    const workoutKeywords = ['workout', 'exercise', 'train', 'session', 'routine', 'plan', 'split'];
    const formKeywords = ['form', 'technique', 'how to', 'proper', 'correct'];
    const injuryKeywords = ['hurt', 'pain', 'injury', 'sore', 'ache', 'strain', 'modify', 'alternative'];
    const motivationKeywords = ['motivate', 'inspire', 'hard', 'difficult', 'struggle', 'give up', 'quit'];
    const progressKeywords = ['progress', 'results', 'improvement', 'plateau', 'stuck', 'gains'];
    const nutritionKeywords = ['nutrition', 'diet', 'eat', 'protein', 'calories', 'meal', 'food'];
    const recoveryKeywords = ['recover', 'rest day', 'recovery', 'stretching', 'cool down'];
    const fatigueKeywords = ['tired', 'fatigue', 'exhausted', 'energy', 'lighter', 'easy'];
    const scheduleKeywords = ['schedule', 'time', 'when', 'busy', 'quick', 'short'];

    if (greetings.some(g => message.startsWith(g))) {
      return { type: 'greeting', confidence: 1.0 };
    }
    if (workoutKeywords.some(k => message.includes(k))) {
      return { type: 'workout_request', confidence: 0.9 };
    }
    if (formKeywords.some(k => message.includes(k))) {
      return { type: 'form_technique', confidence: 0.9 };
    }
    if (injuryKeywords.some(k => message.includes(k))) {
      return { type: 'injury_pain', confidence: 0.95 };
    }
    if (motivationKeywords.some(k => message.includes(k))) {
      return { type: 'motivation', confidence: 0.85 };
    }
    if (progressKeywords.some(k => message.includes(k))) {
      return { type: 'progress_check', confidence: 0.9 };
    }
    if (nutritionKeywords.some(k => message.includes(k))) {
      return { type: 'nutrition', confidence: 0.85 };
    }
    if (recoveryKeywords.some(k => message.includes(k))) {
      return { type: 'recovery', confidence: 0.9 };
    }
    if (fatigueKeywords.some(k => message.includes(k))) {
      return { type: 'fatigue', confidence: 0.9 };
    }
    if (scheduleKeywords.some(k => message.includes(k))) {
      return { type: 'schedule', confidence: 0.8 };
    }

    return { type: 'general', confidence: 0.5 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DATA FETCHING
  // ═══════════════════════════════════════════════════════════════════

  private async getUserData(userId: string) {
    try {
      const [userProfile, workoutLogs, progressData] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          include: { subscriptions: true }
        }),
        prisma.workoutLog.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: { exercise: true }
        }),
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
      const logs = await prisma.workoutLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 100
      });

      const totalWorkouts = logs.length;
      const completedWorkouts = logs.filter(l => l.completed).length;
      const skippedWorkouts = logs.filter(l => l.skipped).length;
      const consistency = totalWorkouts > 0 ? (completedWorkouts / totalWorkouts) * 100 : 0;
      
      // Calculate streak
      let currentStreak = 0;
      const today = new Date();
      for (let i = 0; i < logs.length; i++) {
        const logDate = new Date(logs[i].createdAt);
        const daysDiff = Math.floor((today.getTime() - logDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysDiff === currentStreak && logs[i].completed) {
          currentStreak++;
        } else {
          break;
        }
      }

      return {
        totalWorkouts,
        completedWorkouts,
        skippedWorkouts,
        consistency,
        currentStreak,
        lastWorkoutDate: logs[0]?.createdAt || null
      };
    } catch (error) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GREETING HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private async handleGreeting(userId: string, userProfile: any, workoutLogs: any[]) {
    const hour = new Date().getHours();
    const lastWorkout = workoutLogs[0];
    const streak = await this.calculateStreak(workoutLogs);

    let greeting = '';
    if (hour < 12) greeting = 'Good morning';
    else if (hour < 18) greeting = 'Good afternoon';
    else greeting = 'Good evening';

    const greetings = [
      `${greeting}! Ready to crush your workout today? 💪`,
      `${greeting}! Let's build on that ${streak}-day streak!`,
      `${greeting}, champ! What's your fitness goal today?`,
      `${greeting}! I see you're back—let's make today count!`,
      `${greeting}! Your dedication is inspiring. Shall we train?`
    ];

    const selectedGreeting = greetings[Math.floor(Math.random() * greetings.length)];

    return {
      success: true,
      reply: selectedGreeting,
      type: 'greeting',
      suggestions: [
        'Generate today\'s workout',
        'Check my progress',
        'I need motivation',
        'I have limited time'
      ]
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // WORKOUT REQUEST HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private async handleWorkoutRequest(
    userId: string,
    userProfile: any,
    workoutLogs: any[],
    context: CoachContext,
    intent: any
  ) {
    const fitnessLevel = this.detectFitnessLevel(workoutLogs);
    const goal = userProfile?.fitnessGoal || 'general_fitness';
    const availableTime = context.availableTime || 45;
    const equipment = context.equipment || ['bodyweight'];

    const workout = this.generateWorkout({
      fitnessLevel,
      goal,
      availableTime,
      equipment,
      recentLogs: workoutLogs.slice(0, 7),
      context
    });

    return {
      success: true,
      reply: `Here's your personalized ${availableTime}-minute ${goal.replace('_', ' ')} workout for today:`,
      type: 'workout_plan',
      workout,
      suggestions: [
        'Need modifications?',
        'Explain the exercises',
        'Make it easier',
        'Make it harder'
      ]
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // WORKOUT GENERATION
  // ═══════════════════════════════════════════════════════════════════

  private generateWorkout(params: {
    fitnessLevel: string;
    goal: string;
    availableTime: number;
    equipment: string[];
    recentLogs: any[];
    context: CoachContext;
  }): WorkoutPlan {
    const { fitnessLevel, goal, availableTime, equipment, context } = params;

    // Determine workout type based on goal
    let workoutType = '';
    let exercises: Exercise[] = [];

    if (goal === 'fat_loss') {
      workoutType = 'HIIT Fat Burn';
      exercises = this.generateHIITWorkout(fitnessLevel, availableTime, equipment);
    } else if (goal === 'muscle_gain') {
      workoutType = 'Strength & Hypertrophy';
      exercises = this.generateStrengthWorkout(fitnessLevel, availableTime, equipment);
    } else if (goal === 'endurance') {
      workoutType = 'Endurance Circuit';
      exercises = this.generateEnduranceWorkout(fitnessLevel, availableTime, equipment);
    } else if (goal === 'mobility') {
      workoutType = 'Mobility & Flexibility';
      exercises = this.generateMobilityWorkout(fitnessLevel, availableTime);
    } else {
      workoutType = 'Full Body Conditioning';
      exercises = this.generateFullBodyWorkout(fitnessLevel, availableTime, equipment);
    }

    return {
      type: workoutType,
      duration: availableTime,
      warmup: this.generateWarmup(5),
      exercises,
      cooldown: this.generateCooldown(5),
      notes: this.generateWorkoutNotes(fitnessLevel, goal)
    };
  }

  private generateHIITWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    const exercises: Exercise[] = [
      { name: 'Jumping Jacks', sets: 4, reps: '30 sec', rest: 15, intensity: 'high', formTips: ['Land softly', 'Keep core engaged'] },
      { name: 'Burpees', sets: 4, reps: '20 sec', rest: 20, intensity: 'high', formTips: ['Full plank position', 'Explosive jump'] },
      { name: 'Mountain Climbers', sets: 4, reps: '30 sec', rest: 15, intensity: 'high', formTips: ['Drive knees to chest', 'Maintain plank'] },
      { name: 'High Knees', sets: 4, reps: '30 sec', rest: 15, intensity: 'high', formTips: ['Pump arms', 'Lift knees to hip level'] }
    ];

    if (level === 'beginner') {
      exercises.forEach(ex => {
        ex.sets = 3;
        ex.rest = 30;
        ex.modifications = ['Take breaks as needed', 'Lower impact variations'];
      });
    }

    return exercises.slice(0, Math.floor(time / 5));
  }

  private generateStrengthWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    return [
      { name: 'Push-ups', sets: 4, reps: level === 'beginner' ? 8 : level === 'intermediate' ? 12 : 15, rest: 60, intensity: 'high', formTips: ['Elbows at 45°', 'Core tight', 'Full range of motion'] },
      { name: 'Squats', sets: 4, reps: level === 'beginner' ? 10 : level === 'intermediate' ? 15 : 20, rest: 60, intensity: 'high', formTips: ['Chest up', 'Knees track over toes', 'Full depth'] },
      { name: 'Plank', sets: 3, reps: level === 'beginner' ? '30 sec' : level === 'intermediate' ? '45 sec' : '60 sec', rest: 45, intensity: 'moderate', formTips: ['Straight line', 'Engage glutes', 'Breathe steadily'] },
      { name: 'Lunges', sets: 3, reps: level === 'beginner' ? '8 each leg' : level === 'intermediate' ? '12 each leg' : '15 each leg', rest: 60, intensity: 'moderate', formTips: ['90° angles', 'Vertical torso', 'Control descent'] }
    ];
  }

  private generateEnduranceWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    return [
      { name: 'Running in Place', sets: 3, reps: '2 min', rest: 30, intensity: 'moderate', formTips: ['Light on feet', 'Steady pace'] },
      { name: 'Jumping Rope (mimicked)', sets: 3, reps: '1 min', rest: 30, intensity: 'high', formTips: ['Stay on toes', 'Rhythm'] },
      { name: 'Step-Ups', sets: 3, reps: '15 each leg', rest: 45, intensity: 'moderate', formTips: ['Drive through heel', 'Control'] },
      { name: 'Bicycle Crunches', sets: 3, reps: '20 each side', rest: 30, intensity: 'moderate', formTips: ['Twist fully', 'Slow and controlled'] }
    ];
  }

  private generateMobilityWorkout(level: string, time: number): Exercise[] {
    return [
      { name: 'Cat-Cow Stretch', sets: 2, reps: '10 reps', rest: 30, intensity: 'low', formTips: ['Slow movements', 'Breathe with each rep'] },
      { name: 'World\'s Greatest Stretch', sets: 2, reps: '5 each side', rest: 30, intensity: 'low', formTips: ['Hold each position', 'Deep breaths'] },
      { name: 'Shoulder Circles', sets: 2, reps: '15 each direction', rest: 20, intensity: 'low', formTips: ['Full range', 'Controlled'] },
      { name: 'Hip Circles', sets: 2, reps: '10 each direction', rest: 20, intensity: 'low', formTips: ['Large circles', 'Stable core'] }
    ];
  }

  private generateFullBodyWorkout(level: string, time: number, equipment: string[]): Exercise[] {
    return [
      { name: 'Push-ups', sets: 3, reps: 12, rest: 60, intensity: 'moderate', formTips: ['Core engaged', 'Control'] },
      { name: 'Squats', sets: 3, reps: 15, rest: 60, intensity: 'moderate', formTips: ['Full depth', 'Chest up'] },
      { name: 'Plank', sets: 3, reps: '45 sec', rest: 45, intensity: 'moderate', formTips: ['Straight line', 'Breathe'] },
      { name: 'Glute Bridges', sets: 3, reps: 15, rest: 45, intensity: 'moderate', formTips: ['Squeeze at top', 'Controlled descent'] },
      { name: 'Mountain Climbers', sets: 3, reps: '30 sec', rest: 30, intensity: 'high', formTips: ['Fast pace', 'Solid plank'] }
    ];
  }

  private generateWarmup(duration: number): Exercise[] {
    return [
      { name: 'Arm Circles', sets: 1, reps: '15 each direction', rest: 0, intensity: 'low', formTips: ['Large circles', 'Loose shoulders'] },
      { name: 'Leg Swings', sets: 1, reps: '10 each leg', rest: 0, intensity: 'low', formTips: ['Controlled swing', 'Balance'] },
      { name: 'Bodyweight Squats', sets: 1, reps: 10, rest: 0, intensity: 'low', formTips: ['Gentle', 'Full range'] },
      { name: 'Inchworms', sets: 1, reps: 5, rest: 0, intensity: 'low', formTips: ['Slow', 'Stretch hamstrings'] }
    ];
  }

  private generateCooldown(duration: number): Exercise[] {
    return [
      { name: 'Standing Quad Stretch', sets: 1, reps: '30 sec each leg', rest: 0, intensity: 'low', formTips: ['Balance', 'Gentle pull'] },
      { name: 'Hamstring Stretch', sets: 1, reps: '30 sec each leg', rest: 0, intensity: 'low', formTips: ['Straight leg', 'Reach forward'] },
      { name: 'Shoulder Stretch', sets: 1, reps: '30 sec each arm', rest: 0, intensity: 'low', formTips: ['Pull across chest', 'Relax'] },
      { name: 'Deep Breathing', sets: 1, reps: '10 breaths', rest: 0, intensity: 'low', formTips: ['4-7-8 pattern', 'Calm down'] }
    ];
  }

  private generateWorkoutNotes(level: string, goal: string): string[] {
    const notes = [
      `This workout is tailored for your ${level} fitness level`,
      `Focus on form over speed - quality > quantity`,
      `Stay hydrated throughout your session`,
      `Listen to your body - rest if needed`
    ];

    if (goal === 'fat_loss') {
      notes.push('Minimize rest between sets for maximum calorie burn');
    } else if (goal === 'muscle_gain') {
      notes.push('Focus on controlled tempo and full range of motion');
    } else if (goal === 'endurance') {
      notes.push('Maintain steady pace and breathing rhythm');
    }

    return notes;
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORM & TECHNIQUE HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleFormTechnique(message: string, context: CoachContext, logs: any[]) {
    const exercise = context.currentExercise || this.extractExerciseName(message) || 'this exercise';
    const formGuide = this.getFormGuide(exercise);

    return {
      success: true,
      reply: `Perfect form for ${exercise}:\n\n${formGuide.description}\n\n**Key Points:**\n${formGuide.keyPoints.join('\n')}\n\n**Common Mistakes:**\n${formGuide.commonMistakes.join('\n')}\n\n**Breathing:** ${formGuide.breathing}`,
      type: 'form_tip',
      exercise,
      videoDemo: formGuide.videoUrl
    };
  }

  private getFormGuide(exercise: string) {
    const guides: any = {
      'push-up': {
        description: 'A fundamental upper body pushing exercise targeting chest, shoulders, and triceps.',
        keyPoints: [
          '• Hands shoulder-width apart, fingers pointing forward',
          '• Core engaged - straight line from head to heels',
          '• Elbows at 45° angle to body',
          '• Lower chest to ground, keeping elbows tucked',
          '• Push through palms to return to start'
        ],
        commonMistakes: [
          '❌ Sagging hips (engage core!)',
          '❌ Flaring elbows out wide (keep at 45°)',
          '❌ Partial range of motion (go all the way down)',
          '❌ Looking up (keep neutral neck)'
        ],
        breathing: 'Inhale on the way down, exhale as you push up',
        videoUrl: null
      },
      'squat': {
        description: 'The king of lower body exercises - targets quads, glutes, hamstrings, and core.',
        keyPoints: [
          '• Feet hip to shoulder-width apart, toes slightly out',
          '• Chest up, core braced throughout',
          '• Sit back into hips while keeping chest proud',
          '• Knees track over toes (don\'t cave in)',
          '• Descend until thighs parallel or deeper',
          '• Drive through heels to stand'
        ],
        commonMistakes: [
          '❌ Knees caving inward (push knees out)',
          '❌ Heels lifting off ground (weight in heels)',
          '❌ Forward lean (chest up!)',
          '❌ Shallow depth (go deeper safely)'
        ],
        breathing: 'Inhale at the top, brace and descend, exhale as you drive up',
        videoUrl: null
      },
      'plank': {
        description: 'Core stability exercise that strengthens entire midsection and teaches body control.',
        keyPoints: [
          '• Forearms on ground, elbows under shoulders',
          '• Body in straight line - head to heels',
          '• Squeeze glutes hard',
          '• Engage abs as if bracing for a punch',
          '• Look at ground between hands (neutral neck)'
        ],
        commonMistakes: [
          '❌ Hips sagging (squeeze glutes!)',
          '❌ Hips too high (straight line)',
          '❌ Holding breath (breathe steadily)',
          '❌ Looking forward (neutral neck)'
        ],
        breathing: 'Breathe normally throughout - don\'t hold your breath',
        videoUrl: null
      }
    };

    const exerciseLower = exercise.toLowerCase();
    if (guides[exerciseLower]) {
      return guides[exerciseLower];
    }

    // Default form guide
    return {
      description: `${exercise} is an effective exercise. Here's how to perform it correctly:`,
      keyPoints: [
        '• Maintain proper posture throughout',
        '• Move with control - no jerky motions',
        '• Full range of motion',
        '• Keep core engaged',
        '• Focus on the muscle working'
      ],
      commonMistakes: [
        '❌ Using momentum instead of muscle',
        '❌ Partial range of motion',
        '❌ Poor posture',
        '❌ Holding breath'
      ],
      breathing: 'Exhale on the effort (concentric), inhale on the return (eccentric)',
      videoUrl: null
    };
  }

  private extractExerciseName(message: string): string | null {
    const exercises = ['push-up', 'squat', 'plank', 'lunge', 'burpee', 'pull-up', 'deadlift', 'row'];
    for (const ex of exercises) {
      if (message.includes(ex)) {
        return ex;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // INJURY & PAIN HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleInjuryPain(message: string, context: CoachContext, userProfile: any, logs: any[]) {
    const bodyPart = this.extractBodyPart(message);
    const exercise = context.currentExercise || this.extractExerciseName(message);
    const alternatives = this.getSafeAlternatives(exercise, bodyPart);

    return {
      success: true,
      reply: `I understand you're experiencing discomfort${bodyPart ? ` in your ${bodyPart}` : ''}. Your safety is the priority.\n\n**Safe Alternatives:**\n${alternatives.map((alt, i) => `${i + 1}. ${alt.name} - ${alt.reason}`).join('\n')}\n\n⚠️ **Safety Notes:**\n• Stop immediately if pain increases\n• Pain should never be ignored\n• Consider consulting a healthcare professional if pain persists\n• Focus on pain-free range of motion\n\nShall I adjust today's workout to avoid aggravating this area?`,
      type: 'injury_modification',
      alternatives,
      bodyPart
    };
  }

  private extractBodyPart(message: string): string | null {
    const bodyParts = ['wrist', 'elbow', 'shoulder', 'back', 'knee', 'ankle', 'hip', 'neck'];
    for (const part of bodyParts) {
      if (message.includes(part)) {
        return part;
      }
    }
    return null;
  }

  private getSafeAlternatives(exercise: string | null, bodyPart: string | null) {
    // Return safe alternatives based on injury
    if (bodyPart === 'wrist') {
      return [
        { name: 'Forearm Plank', reason: 'No wrist pressure' },
        { name: 'Wall Push-ups', reason: 'Reduced load on wrists' },
        { name: 'Resistance Band Exercises', reason: 'Wrist-neutral movements' }
      ];
    }
    if (bodyPart === 'knee') {
      return [
        { name: 'Wall Sits', reason: 'Static hold, less joint stress' },
        { name: 'Glute Bridges', reason: 'Strengthens without knee flexion' },
        { name: 'Swimming or Cycling', reason: 'Low impact cardio' }
      ];
    }
    if (bodyPart === 'shoulder') {
      return [
        { name: 'Knee Push-ups', reason: 'Reduced load' },
        { name: 'Band Pull-aparts', reason: 'Shoulder-friendly strengthening' },
        { name: 'Dead Bugs', reason: 'Core work without shoulder stress' }
      ];
    }

    return [
      { name: 'Reduced Range of Motion', reason: 'Work within pain-free zone' },
      { name: 'Lighter Resistance', reason: 'Reduce load on affected area' },
      { name: 'Isometric Holds', reason: 'Build strength without movement' }
    ];
  }

  // ═══════════════════════════════════════════════════════════════════
  // MOTIVATION HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private async handleMotivation(userId: string, userProfile: any, logs: any[], progressData: any) {
    const streak = progressData?.currentStreak || 0;
    const totalWorkouts = progressData?.totalWorkouts || 0;
    const consistency = progressData?.consistency || 0;

    const motivationalMessages = [
      `You've logged ${totalWorkouts} workouts! That's ${totalWorkouts * 45} minutes of pure dedication. Every single rep counts. 💪`,
      `${streak}-day streak! You're not just training your body—you're building discipline. Keep showing up.`,
      `Remember why you started. You're ${consistency.toFixed(0)}% consistent. That's ${consistency.toFixed(0)}% closer to your goals!`,
      `The hardest part is showing up. You've already done that ${totalWorkouts} times. One more rep. You've got this!`,
      `Struggle builds strength. Every workout is progress, even when it doesn't feel like it. Trust the process.`
    ];

    const message = motivationalMessages[Math.floor(Math.random() * motivationalMessages.length)];

    return {
      success: true,
      reply: message,
      type: 'motivation',
      stats: {
        streak,
        totalWorkouts,
        consistency: `${consistency.toFixed(0)}%`
      },
      suggestions: [
        'Show me my progress',
        'Set a new goal',
        'I want to workout now'
      ]
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROGRESS CHECK HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private async handleProgressCheck(userId: string, logs: any[], progressData: any) {
    const weeklyWorkouts = this.getWeeklyWorkouts(logs);
    const improvements = this.detectImprovements(logs);
    const prediction = this.predictNextMilestone(logs);

    return {
      success: true,
      reply: `📊 **Your Progress Report**\n\n**This Week:** ${weeklyWorkouts} workouts completed\n**Current Streak:** ${progressData?.currentStreak || 0} days\n**Consistency:** ${progressData?.consistency?.toFixed(0) || 0}%\n**Total Workouts:** ${progressData?.totalWorkouts || 0}\n\n${improvements.length > 0 ? `🎯 **Recent Improvements:**\n${improvements.join('\n')}` : ''}\n\n${prediction}\n\nKeep pushing! You're making real progress.`,
      type: 'progress_report',
      data: {
        weeklyWorkouts,
        streak: progressData?.currentStreak,
        consistency: progressData?.consistency,
        improvements
      }
    };
  }

  private getWeeklyWorkouts(logs: any[]): number {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    return logs.filter(log => new Date(log.createdAt) >= oneWeekAgo && log.completed).length;
  }

  private detectImprovements(logs: any[]): string[] {
    const improvements: string[] = [];
    
    // Simple improvement detection
    if (logs.length >= 10) {
      const recentAvgSets = logs.slice(0, 5).reduce((sum, log) => sum + (log.sets || 0), 0) / 5;
      const olderAvgSets = logs.slice(5, 10).reduce((sum, log) => sum + (log.sets || 0), 0) / 5;
      
      if (recentAvgSets > olderAvgSets * 1.1) {
        improvements.push('• 📈 Volume increased by 10%+');
      }
    }

    if (logs.slice(0, 7).every(log => log.completed)) {
      improvements.push('• 🔥 Perfect workout week!');
    }

    return improvements;
  }

  private predictNextMilestone(logs: any[]): string {
    const total = logs.length;
    if (total < 50) {
      return `🎯 **Next Milestone:** Reach 50 total workouts (${50 - total} more to go!)`;
    } else if (total < 100) {
      return `🎯 **Next Milestone:** Reach 100 total workouts (${100 - total} more to go!)`;
    } else {
      return `🎯 You're a fitness veteran with ${total} workouts! Keep setting new records.`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // NUTRITION HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleNutrition(userProfile: any, logs: any[], intent: any) {
    const goal = userProfile?.fitnessGoal || 'general_fitness';
    const tips = this.getNutritionTips(goal);

    return {
      success: true,
      reply: `🍎 **Nutrition Tips for ${goal.replace('_', ' ')}:**\n\n${tips.join('\n')}\n\n⚠️ *Note: These are general guidelines. Consult a nutritionist for personalized advice.*`,
      type: 'nutrition_advice',
      goal
    };
  }

  private getNutritionTips(goal: string): string[] {
    const tips: any = {
      fat_loss: [
        '🔸 **Calorie Deficit:** Aim for 300-500 cal below maintenance',
        '🔸 **Protein:** 1.6-2.2g per kg bodyweight to preserve muscle',
        '🔸 **Hydration:** Drink 3-4 liters of water daily',
        '🔸 **Meal Timing:** Eat protein within 2 hours post-workout',
        '🔸 **Whole Foods:** Prioritize vegetables, lean proteins, complex carbs'
      ],
      muscle_gain: [
        '🔸 **Calorie Surplus:** Aim for 300-500 cal above maintenance',
        '🔸 **Protein:** 1.8-2.4g per kg bodyweight for muscle growth',
        '🔸 **Carbs:** Fuel workouts with complex carbs (rice, oats, potatoes)',
        '🔸 **Post-Workout:** Consume protein + carbs within 1-2 hours',
        '🔸 **Consistency:** Eat every 3-4 hours to support muscle synthesis'
      ],
      endurance: [
        '🔸 **Carbs:** Primary fuel source - eat adequate complex carbs',
        '🔸 **Hydration:** Replace fluids lost during long sessions',
        '🔸 **Electrolytes:** Sodium, potassium, magnesium for performance',
        '🔸 **Recovery:** Protein + carbs post-workout for glycogen replenishment',
        '🔸 **Timing:** Eat 2-3 hours before intense sessions'
      ],
      general_fitness: [
        '🔸 **Balance:** Mix of proteins, carbs, healthy fats',
        '🔸 **Protein:** 1.2-1.6g per kg bodyweight',
        '🔸 **Hydration:** 2-3 liters water daily',
        '🔸 **Vegetables:** Fill half your plate with veggies',
        '🔸 **Processed Foods:** Minimize junk food intake'
      ]
    };

    return tips[goal] || tips['general_fitness'];
  }

  // ═══════════════════════════════════════════════════════════════════
  // RECOVERY HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleRecovery(userProfile: any, logs: any[]) {
    const recentWorkouts = logs.slice(0, 7);
    const workoutFrequency = recentWorkouts.filter(log => log.completed).length;
    
    let recoveryAdvice = '';
    if (workoutFrequency >= 6) {
      recoveryAdvice = 'You\'ve trained 6+ days this week. Your body needs rest to adapt and grow stronger. I recommend a full rest day or active recovery.';
    } else if (workoutFrequency >= 4) {
      recoveryAdvice = 'You\'re training consistently! Consider an active recovery session today—light cardio, stretching, or yoga.';
    } else {
      recoveryAdvice = 'Recovery is important, but you have room to train more this week. Listen to your body—if you feel good, let\'s workout!';
    }

    return {
      success: true,
      reply: `🧘 **Recovery Guidance:**\n\n${recoveryAdvice}\n\n**Active Recovery Ideas:**\n• 20-min walk\n• Gentle yoga or stretching\n• Foam rolling session\n• Light swimming\n• Mobility drills\n\n**Recovery Tips:**\n• Sleep 7-9 hours tonight\n• Stay hydrated\n• Eat adequate protein\n• Stretch major muscle groups\n• Manage stress`,
      type: 'recovery_advice',
      workoutFrequency
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // FATIGUE HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleFatigue(userId: string, userProfile: any, logs: any[], context: CoachContext) {
    return {
      success: true,
      reply: `No problem! Fatigue is real. Let's adjust:\n\n**Option 1: Lighter Session**\nReduce volume by 30% and focus on form\n\n**Option 2: Active Recovery**\nGentle stretching, walking, or yoga\n\n**Option 3: Full Rest Day**\nYour body might need complete recovery\n\nWhat sounds best today? Remember: rest is part of training.`,
      type: 'fatigue_adjustment',
      suggestions: [
        'Give me a light workout',
        'Active recovery plan',
        'I\'ll take a rest day',
        'Actually, I feel better now'
      ]
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCHEDULING HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleScheduling(userId: string, userProfile: any, logs: any[], context: CoachContext) {
    const availableTime = context.availableTime || 15;
    
    let message = '';
    if (availableTime < 15) {
      message = `Only ${availableTime} minutes? No problem! Here's a quick, effective routine:\n\n**10-Minute Express Workout:**\n• Jumping Jacks - 1 min\n• Push-ups - 1 min\n• Squats - 1 min\n• Plank - 1 min\n• Burpees - 1 min\n• Rest - 30 sec\nRepeat 2x\n\nShort workouts > no workout!`;
    } else if (availableTime < 30) {
      message = `${availableTime} minutes is perfect for a focused session. I'll create a ${availableTime}-minute workout targeting your goals.`;
    } else {
      message = `Great! ${availableTime} minutes allows for a comprehensive workout. Let's make it count!`;
    }

    return {
      success: true,
      reply: message,
      type: 'time_based_workout',
      duration: availableTime
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEFAULT HANDLER
  // ═══════════════════════════════════════════════════════════════════

  private handleDefault(userId: string, userProfile: any, logs: any[], message: string) {
    return {
      success: true,
      reply: `I'm here to help with:\n• 🏋️ Workout plans\n• 📊 Progress tracking\n• 💪 Motivation\n• 🩺 Form corrections\n• 🍎 Basic nutrition tips\n• 🧘 Recovery advice\n\nWhat would you like help with?`,
      type: 'general',
      suggestions: [
        'Generate a workout',
        'Check my progress',
        'I need motivation',
        'Nutrition tips'
      ]
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

  private async calculateStreak(logs: any[]): Promise<number> {
    let streak = 0;
    const today = new Date();
    
    for (let i = 0; i < logs.length; i++) {
      const logDate = new Date(logs[i].createdAt);
      const daysDiff = Math.floor((today.getTime() - logDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysDiff === streak && logs[i].completed) {
        streak++;
      } else {
        break;
      }
    }
    
    return streak;
  }
}

export const aiCoach = new AICoachService();
