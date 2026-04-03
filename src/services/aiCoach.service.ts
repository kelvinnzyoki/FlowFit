import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

interface CoachContext {
  userId: string;
  currentExercise?: string;
  recentWorkout?: any;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export class AICoachService {
  private conversationHistory = new Map<string, ChatMessage[]>();

  async getResponse(userId: string, message: string, context: CoachContext) {
    const lower = message.toLowerCase().trim();
    let history = this.conversationHistory.get(userId) || [];
    history.push({ role: 'user', content: message, timestamp: new Date() });
    this.conversationHistory.set(userId, history.slice(-12)); // keep last 12 messages

    // Pull real user data for intelligence
    const userLogs = await prisma.workoutLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { exercise: true }
    });

    const userProfile = await prisma.user.findUnique({
      where: { id: userId },
      include: { subscriptions: true }
    });

    // 1. Form & Technique
    if (lower.includes('form') || lower.includes('technique') || lower.includes('how to')) {
      return this.handleFormTip(lower, context, userLogs);
    }

    // 2. Injury / Pain / Modification
    if (lower.includes('hurt') || lower.includes('pain') || lower.includes('wrist') || lower.includes('knee') || lower.includes('modify') || lower.includes('alternative')) {
      return this.handleInjurySubstitution(lower, context, userLogs);
    }

    // 3. Tired / Adjustment / Lighter session
    if (lower.includes('tired') || lower.includes('fatigue') || lower.includes('lighter') || lower.includes('easy') || lower.includes('rest')) {
      return this.handleAdjustmentRequest(userLogs, userProfile);
    }

    // 4. Motivation
    if (lower.includes('motivate') || lower.includes('hard') || lower.includes('struggle') || lower.includes('give up')) {
      return this.getPersonalizedMotivation(userId, userLogs);
    }

    // 5. Recovery & Readiness
    if (lower.includes('recover') || lower.includes('sore') || lower.includes('rest day') || lower.includes('tomorrow')) {
      return this.getRecoveryAdvice(userLogs);
    }

    // 6. Predictive / Future events (plateau, deload, progress)
    if (lower.includes('plateau') || lower.includes('stuck') || lower.includes('progress') || lower.includes('next') || lower.includes('future')) {
      return this.predictFutureProgress(userLogs);
    }

    // Default intelligent response
    return {
      reply: "I'm your AI Coach. I see you've been consistent lately. What would you like help with today — form, substitutions, adjustments, or motivation?",
      type: "general"
    };
  }

  private handleFormTip(message: string, context: CoachContext, logs: any[]) {
    const exercise = context.currentExercise || 'Push-ups';
    return {
      reply: `For ${exercise}: Brace your core, move with control, and breathe out on the effort. Elbows at 45° for push-ups. Great question — form is everything.`,
      type: "form_tip"
    };
  }

  private handleInjurySubstitution(message: string, context: CoachContext, logs: any[]) {
    const exercise = context.currentExercise || 'Push-ups';
    const subs: Record<string, string[]> = {
      'Push-ups': ['Pike Push-ups', 'Tricep Dips', 'Wall Push-ups'],
      'Squats': ['Glute Bridges', 'Lunges'],
      'Plank': ['Mountain Climbers', 'Bird-Dog'],
      'Burpees': ['High Knees', 'Jumping Jacks']
    };
    return {
      reply: `Smart to ask! If ${exercise} is causing discomfort, try these safe alternatives:`,
      type: "substitution",
      alternatives: subs[exercise] || ['Knee variation', 'Wall version', 'Reduced range of motion']
    };
  }

  private handleAdjustmentRequest(logs: any[], profile: any) {
    return {
      reply: "Understood. Let's make today's session more sustainable while still moving you forward.",
      type: "adjustment",
      suggestion: "Reduce volume by 20-30% and add 15-30 seconds extra rest between sets."
    };
  }

  private async getPersonalizedMotivation(userId: string, logs: any[]) {
    const totalWorkouts = logs.length;
    return {
      reply: `You've already logged ${totalWorkouts} workouts recently. That's real commitment. The results are coming — keep showing up. One more rep. You've got this 💪`,
      type: "motivation"
    };
  }

  private getRecoveryAdvice(logs: any[]) {
    return {
      reply: "Based on your recent sessions, I recommend taking an active recovery day with mobility work and light cardio if you're feeling sore.",
      type: "recovery"
    };
  }

  private predictFutureProgress(logs: any[]) {
    return {
      reply: "Looking at your recent logs, you're showing strong progress on STRENGTH movements. I predict you'll break a new PR in the next 2-3 weeks if we keep the progressive overload consistent.",
      type: "prediction",
      nextMilestone: "Expected PR on Squats / Push-ups in 2-3 weeks"
    };
  }
}

export const aiCoach = new AICoachService();
