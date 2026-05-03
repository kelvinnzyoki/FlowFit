/**
 * FLOWFIT — Admin Routes
 *
 * Protected by ADMIN_SECRET header. Mount in server.ts:
 *   import adminRoutes from './routes/admin.routes.js';
 *   app.use('/api/v1/admin', adminRoutes);
 *
 * Step 1 — check health:
 *   GET  /api/v1/admin/subscription-health
 *   Header: x-admin-secret: <ADMIN_SECRET>
 *
 * Step 2 — fix missing tokens:
 *   POST /api/v1/admin/backfill-paystack-tokens
 *   Header: x-admin-secret: <ADMIN_SECRET>
 */

import { Router, Request, Response } from "express";
import prisma from "../config/db.js";

const router = Router();

// ── Secret guard ──────────────────────────────────────────────────────────────
function adminGuard(req: Request, res: Response, next: () => void) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(500).json({ error: "ADMIN_SECRET env var not set." });
    return;
  }
  if (req.headers["x-admin-secret"] !== secret) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}

// ── GET /api/v1/admin/subscription-health ─────────────────────────────────────
router.get("/subscription-health", adminGuard, async (_req, res) => {
  try {
    const base = { provider: "PAYSTACK", status: { in: ["ACTIVE", "PAST_DUE", "TRIALING"] } };
    const [total, missingCode, missingToken, missingBoth, noRef] = await Promise.all([
      prisma.subscription.count({ where: base }),
      prisma.subscription.count({ where: { ...base, paystackSubscriptionCode: null } }),
      prisma.subscription.count({ where: { ...base, paystackEmailToken: null } }),
      prisma.subscription.count({ where: { ...base, paystackSubscriptionCode: null, paystackEmailToken: null } }),
      prisma.subscription.count({ where: { ...base, paystackReference: null } }),
    ]);
    res.json({
      success: true,
      health: { activePaystackSubs: total, missingSubscriptionCode: missingCode, missingEmailToken: missingToken, missingBoth, hasNoReferenceToVerify: noRef },
      action: (missingCode > 0 || missingToken > 0) ? "POST /api/v1/admin/backfill-paystack-tokens to fix" : "All good",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/v1/admin/backfill-paystack-tokens ───────────────────────────────
//
// WHY PREVIOUS BACKFILL RETURNED EMPTY:
//   GET /subscription?customer=email only works when Paystack has a formal
//   Customer object linked to that email. initializeTransaction with just an
//   email does NOT create a Paystack Customer, so that endpoint returns nothing.
//
// FIX: Use paystackReference (already in DB) to call
//   GET /transaction/verify/:reference
// The verify response always contains the nested subscription object with
// subscription_code + email_token regardless of customer setup.
//
router.post("/backfill-paystack-tokens", adminGuard, async (_req, res) => {
  const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!SECRET_KEY) { res.status(500).json({ error: "PAYSTACK_SECRET_KEY not set." }); return; }

  async function verifyTxn(ref: string) {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });
    const j = await r.json() as { status: boolean; data: any; message: string };
    if (!j.status) throw new Error(j.message);
    return j.data;
  }

  async function listByCustomer(customerCode: string) {
    const r = await fetch(`https://api.paystack.co/subscription?customer=${customerCode}`, {
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });
    const j = await r.json() as { status: boolean; data: any[] };
    return j.status ? (j.data ?? []) : [];
  }

  const results: any[] = [];

  try {
    const broken = await prisma.subscription.findMany({
      where: {
        provider: "PAYSTACK",
        status: { in: ["ACTIVE", "PAST_DUE", "TRIALING"] },
        paystackReference: { not: null },
        OR: [{ paystackSubscriptionCode: null }, { paystackEmailToken: null }],
      },
      orderBy: { createdAt: "desc" },
    });

    if (broken.length === 0) {
      res.json({ success: true, message: "Nothing to fix.", results: [] });
      return;
    }

    for (const sub of broken) {
      const reference = sub.paystackReference!;
      try {
        const txn = await verifyTxn(reference);
        let subCode  = txn.subscription?.subscription_code as string | undefined;
        let token    = txn.subscription?.email_token       as string | undefined;

        // If the verify response has no subscription object, try customer_code lookup
        if (!subCode) {
          const custCode = txn.customer?.customer_code as string | undefined;
          if (custCode) {
            const list = await listByCustomer(custCode);
            if (list.length > 0) {
              const latest = list.sort((a: any, b: any) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
              )[0];
              subCode = latest.subscription_code;
              token   = latest.email_token;
            }
          }
        }

        if (!subCode && !token) {
          results.push({ id: sub.id, reference, outcome: "SKIPPED — no subscription object on this transaction. Was a plan code sent at checkout?" });
          continue;
        }

        await prisma.subscription.update({
          where: { id: sub.id },
          data: {
            ...(subCode && { paystackSubscriptionCode: subCode }),
            ...(token   && { paystackEmailToken:       token  }),
          },
        });

        results.push({ id: sub.id, reference, outcome: `UPDATED — code=${subCode ?? "(kept)"} token=${token ? "✓" : "(kept)"}` });

      } catch (err: any) {
        results.push({ id: sub.id, reference, outcome: `ERROR — ${err.message}` });
      }
    }

    const noRef = await prisma.subscription.count({
      where: {
        provider: "PAYSTACK",
        status: { in: ["ACTIVE", "PAST_DUE", "TRIALING"] },
        paystackReference: null,
        OR: [{ paystackSubscriptionCode: null }, { paystackEmailToken: null }],
      },
    });

    res.json({
      success: true,
      total: broken.length,
      results,
      skippedNoReference: noRef,
      note: noRef > 0 ? `${noRef} row(s) have no paystackReference — check Paystack dashboard manually.` : undefined,
    });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
