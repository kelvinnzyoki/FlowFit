import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

type FeedbackType = 'bug' | 'suggestion' | 'complaint' | 'praise';

interface AuthedRequest extends Request {
  user?: {
    id?: string;
    userId?: string;
    email?: string;
    role?: string;
  };
}

const router = Router();

const ALLOWED_TYPES: FeedbackType[] = ['bug', 'suggestion', 'complaint', 'praise'];

router.post('/', requireAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const typeRaw = String(req.body?.type || 'suggestion').toLowerCase();
    const type = ALLOWED_TYPES.includes(typeRaw as FeedbackType)
      ? (typeRaw as FeedbackType)
      : 'suggestion';

    const message = String(req.body?.message || '').trim();
    const pageUrl = req.body?.pageUrl ? String(req.body.pageUrl).trim().slice(0, 500) : null;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    if (message.length < 5) {
      return res.status(400).json({ success: false, error: 'Feedback message is too short.' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ success: false, error: 'Feedback message is too long.' });
    }

    const feedback = await prisma.feedback.create({
      data: {
        userId,
        type,
        message,
        pageUrl,
        status: 'NEW',
      },
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
      },
    });

    return res.status(201).json({ success: true, feedback });
  } catch (err) {
    return next(err);
  }
});

export default router;
