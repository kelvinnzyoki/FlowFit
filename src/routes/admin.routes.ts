/**
 * FLOWFIT — Admin Routes
 *
 * One-off maintenance endpoints protected by ADMIN_SECRET env var.
 * Never expose these without the secret header check.
 *
 * Usage — trigger the backfill from any HTTP client:
 *
 *   curl -X POST https://your-api.vercel.app/api/v1/admin/backfill-paystack-tokens \
 *     -H "x-admin-secret: your_ADMIN_SECRET_value"
 *
 * Or open it in a browser (GET version) and add the header via
 * a tool like Requestly, or just use Postman / Insomnia.
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/db.js';

const router = Router();

// ── Secret guard — every admin route requires this header ─────────────────────
function adminGuard(req: Request, res: Response, next: () => void) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'ADMIN_SECRET env var not set on server.' });
    return;
  }
  if (req.headers['x-admin-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }
  next();
}

// ── POST /api/v1/admin/backfill-paystack-tokens ───────────────────────────────
// Finds all ACTIVE/TRIALING/PAST_DUE Paystack subscriptions with NULL
// subscription codes or email tokens, fetches the correct values from
// Paystack's API, and updates the DB rows.
router.post(
  '/backfill-paystack-tokens',
  adminGuard,
  async (_req: Request, res: Response) => {
    const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!SECRET_KEY) {
      res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not set.' });
      return;
    }

    async function paystackGet<T>(path: string): Promise<T> {
      const r = await fetch(`https://api.paystack.co${path}`, {
        headers: { Authorization: `Bearer ${SECRET_KEY}` },
      });
      const json = (await r.json()) as { status: boolean; data: T; message: string };
      if (!json.status) throw new Error(`Paystack (${path}): ${json.message}`);
      return json.data;
    }

    const results: Array<{
      subscriptionId: string;
      userId: string;
      email: string;
      outcome: string;
    }> = [];

    try {
      // 1. Find all subscriptions missing tokens
      const broken = await prisma.subscription.findMany({
        where: {
          provider: 'PAYSTACK',
          status:   { in: ['ACTIVE', 'PAST_DUE', 'TRIALING'] },
          OR: [
            { paystackSubscriptionCode: null },
            { paystackEmailToken: null },
          ],
        },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      });

      if (broken.length === 0) {
        res.json({ success: true, message: 'Nothing to fix — all tokens already populated.', results: [] });
        return;
      }

      // 2. For each broken subscription, fetch tokens from Paystack
      for (const sub of broken) {
        const user = await prisma.user.findUnique({
          where:  { id: sub.userId },
          select: { email: true },
        });

        if (!user?.email) {
          results.push({
            subscriptionId: sub.id,
            userId: sub.userId,
            email: '—',
            outcome: 'SKIPPED — no email found for user',
          });
          continue;
        }

        try {
          // Fetch all Paystack subscriptions for this customer email
          const allSubs = await paystackGet<any[]>(
            `/subscription?customer=${encodeURIComponent(user.email)}`
          );

          if (!allSubs || allSubs.length === 0) {
            results.push({
              subscriptionId: sub.id,
              userId: sub.userId,
              email: user.email,
              outcome: 'SKIPPED — no Paystack subscriptions found for this email',
            });
            continue;
          }

          // Match by plan code if possible; otherwise take the most recent
          const planCode = sub.interval === 'YEARLY'
            ? (sub.plan as any)?.paystackPlanCodeYearly
            : (sub.plan as any)?.paystackPlanCodeMonthly;

          const matched = (planCode
            ? allSubs.find((s: any) => s.plan?.plan_code === planCode)
            : null) ?? allSubs.sort(
              (a: any, b: any) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            )[0];

          if (!matched?.subscription_code) {
            results.push({
              subscriptionId: sub.id,
              userId: sub.userId,
              email: user.email,
              outcome: 'SKIPPED — Paystack returned a subscription but with no code',
            });
            continue;
          }

          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              paystackSubscriptionCode: matched.subscription_code ?? null,
              paystackEmailToken:       matched.email_token       ?? null,
            },
          });

          results.push({
            subscriptionId: sub.id,
            userId: sub.userId,
            email: user.email,
            outcome: `UPDATED — code=${matched.subscription_code} token=${matched.email_token ? '✓' : 'null'}`,
          });

        } catch (err: any) {
          results.push({
            subscriptionId: sub.id,
            userId: sub.userId,
            email: user.email,
            outcome: `ERROR — ${err.message}`,
          });
        }
      }

      res.json({
        success: true,
        total:   broken.length,
        results,
      });

    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

export default router;
