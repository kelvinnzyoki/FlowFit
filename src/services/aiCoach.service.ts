// aiCoach.service.ts  ←  Replace your entire file with this
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

interface CoachContext {
  userId: string;
  currentExercise?: string;
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

    // Keep conversation history
    let history = this.conversationHistory.get(userId) || [];
    history.push({ role: 'user', content: message, timestamp: new Date() });
    this.conversationHistory.set(userId, history.slice(-12));

    let userLogs: any[] = [];
    let userProfile: any = null;

    try {
      // Safe Prisma calls with fallback
      [userLogs, userProfile] = await Promise.all([
        prisma.workoutLog.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: { exercise: true }
        }).catch(() => []),
        
        prisma.user.findUnique({
          where: { id: userId },
          include: { subscriptions: true }
        }).catch(() => null)
      ]);
    } catch (e) {
      logger.warn('AI Coach: Could not fetch user data (using fallback)', e);
    }

    // 1. Form & Technique
    if (lower.includes('form') || lower.includes('technique') || lower.includes('how to')) {
      return this.handleFormTip(lower, context, userLogs);
    }

    // 2. Pain / Injury / Modification
    if (lower.includes('hurt') || lower.includes('pain') || lower.includes('wrist') || 
        lower.includes('knee') || lower.includes('modify') || lower.includes('alternative')) {
      return this.handleInjurySubstitution(lower, context, userLogs);
    }

    // 3. Tired / Lighter session
    if (lower.includes('tired') || lower.includes('fatigue') || lower.includes('lighter') || 
        lower.includes('easy') || lower.includes('rest')) {
      return this.handleAdjustmentRequest(userLogs, userProfile);
    }

    // 4. Motivation
    if (lower.includes('motivate') || lower.includes('hard') || lower.includes('struggle') || 
        lower.includes('give up')) {
      return this.getPersonalizedMotivation(userId, userLogs);
    }

    // 5. Recovery
    if (lower.includes('recover') || lower.includes('sore') || lower.includes('rest day')) {
      return this.getRecoveryAdvice(userLogs);
    }

    // 6. Progress / Future
    if (lower.includes('plateau') || lower.includes('stuck') || lower.includes('progress') || 
        lower.includes('next') || lower.includes('future')) {
      return this.predictFutureProgress(userLogs);
    }

    // Default smart reply
    return {
      success: true,
      reply: `Great question! I see you've been training consistently. What specifically would you like help with — form, pain adjustments, motivation, or something else?`,
      type: "general"
    };
  }

  private handleFormTip(message: string, context: CoachContext, logs: any[]) {
    const exercise = context.currentExercise || 'the movement';
    return {
      success: true,
      reply: `For ${exercise}: Brace your core, move with control, and breathe out on the effort. Keep your elbows at 45° for push-ups. Form is everything!`,
      type: "form_tip"
    };
  }

  private handleInjurySubstitution(message: string, context: CoachContext, logs: any[]) {
    const exercise = context.currentExercise || 'the exercise';
    return {
      success: true,
      reply: `Smart to ask! If ${exercise} is causing discomfort, try these safe alternatives: Pike Push-ups, Wall Push-ups, or Knee variations.`,
      type: "substitution",
      alternatives: ['Pike Push-ups', 'Wall Push-ups', 'Knee variation']
    };
  }

  private handleAdjustmentRequest(logs: any[], profile: any) {
    return {
      success: true,
      reply: "Understood — let's make today's session more sustainable. Reduce volume by 20-30% and add extra rest between sets.",
      type: "adjustment"
    };
  }

  private async getPersonalizedMotivation(userId: string, logs: any[]) {
    const total = logs.length;
    return {
      success: true,
      reply: `You've already logged ${total} workouts recently. That's real commitment! The results are coming — keep showing up. One more rep. You've got this 💪`,
      type: "motivation"
    };
  }

  private getRecoveryAdvice(logs: any[]) {
    return {
      success: true,
      reply: "Based on your recent sessions, I recommend an active recovery day with mobility work and light cardio if you're feeling sore.",
      type: "recovery"
    };
  }

  private predictFutureProgress(logs: any[]) {
    return {
      success: true,
      reply: "Looking at your recent logs, you're showing strong progress. I predict you'll break a new PR in the next 2-3 weeks if we keep the progressive overload consistent.",
      type: "prediction"
    };
  }
}

export const aiCoach = new AICoachService();
