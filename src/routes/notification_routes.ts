/**
 * FLOWFIT — Notification Routes
 *
 * All routes require authentication.
 *
 * GET  /notifications          → { notifications: [...], unreadCount: N }
 * GET  /notifications/unread   → { count: N }
 * PUT  /notifications/:id/read → mark one read
 * PUT  /notifications/read-all → mark all read
 * DEL  /notifications/:id      → delete one
 */

import { Router, Request, Response } from 'express';
import { rateLimit }                 from 'express-rate-limit';
import { authenticate }              from '../middleware/auth.middleware.js';
import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} from '../services/notification.service.js';

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many notification requests.' },
});

router.use(authenticate, limiter);

// ─── GET /notifications ───────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit      = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const unreadOnly = req.query.unread === 'true';

    const [notifications, unreadCount] = await Promise.all([
      getNotifications(req.user!.id, limit, unreadOnly),
      getUnreadCount(req.user!.id),
    ]);

    res.json({ success: true, notifications, unreadCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to fetch notifications' });
  }
});

// ─── GET /notifications/unread ────────────────────────────────────────────────
router.get('/unread', async (req: Request, res: Response) => {
  try {
    const count = await getUnreadCount(req.user!.id);
    res.json({ success: true, count });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to fetch unread count' });
  }
});

// ─── PUT /notifications/read-all ──────────────────────────────────────────────
router.put('/read-all', async (req: Request, res: Response) => {
  try {
    await markAllRead(req.user!.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to mark all as read' });
  }
});

// ─── PUT /notifications/:id/read ──────────────────────────────────────────────
router.put('/:id/read', async (req: Request, res: Response) => {
  try {
    await markRead(req.user!.id, req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to mark as read' });
  }
});

// ─── DELETE /notifications/:id ────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await deleteNotification(req.user!.id, req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to delete notification' });
  }
});

export default router;
