import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

function getRawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  // If this branch runs in production, the route was mounted after express.json().
  return Buffer.from(JSON.stringify(req.body || {}));
}

function verifyPaystackSignature(req: Request) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured');
  }

  const signature = String(req.headers['x-paystack-signature'] || '');
  if (!signature) {
    throw new Error('Missing Paystack webhook signature');
  }

  const rawBody = getRawBody(req);
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

  const left = Buffer.from(hash, 'hex');
  const right = Buffer.from(signature, 'hex');

  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('Invalid Paystack webhook signature');
  }

  return JSON.parse(rawBody.toString('utf8'));
}

router.post('/paystack', async (req: Request, res: Response) => {
  let event: any;

  try {
    event = verifyPaystackSignature(req);
  } catch (error: any) {
    console.error('[Paystack webhook] Signature verification failed:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }

  try {
    const externalId = String(event?.data?.id || event?.data?.reference || event?.event || crypto.randomUUID());

    const alreadyProcessed = await prisma.webhookEvent.findUnique({
      where: { externalId },
    }).catch(() => null);

    if (alreadyProcessed) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    await prisma.webhookEvent.create({
      data: {
        externalId,
        provider: 'paystack',
        eventType: String(event?.event || 'unknown'),
        responseStatus: 200,
      },
    });

    const eventName = String(event?.event || '');
    const data = event?.data || {};
    const reference = data.reference || data.payment_reference || data.subscription_code;

    if (eventName === 'charge.success' && reference) {
      await prisma.payment.updateMany({
        where: { paystackReference: String(reference) },
        data: {
          status: 'SUCCESS',
          paidAt: data.paid_at ? new Date(data.paid_at) : new Date(),
        },
      }).catch((err) => console.error('[Paystack webhook] payment update failed:', err));
    }

    if ((eventName === 'subscription.create' || eventName === 'subscription.enable') && data.subscription_code) {
      await prisma.subscription.updateMany({
        where: { paystackSubscriptionCode: String(data.subscription_code) },
        data: {
          status: 'ACTIVE',
          paystackEmailToken: data.email_token || undefined,
          paystackCustomerCode: data.customer?.customer_code || undefined,
        },
      }).catch((err) => console.error('[Paystack webhook] subscription update failed:', err));
    }

    if ((eventName === 'subscription.disable' || eventName === 'subscription.not_renew') && data.subscription_code) {
      await prisma.subscription.updateMany({
        where: { paystackSubscriptionCode: String(data.subscription_code) },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      }).catch((err) => console.error('[Paystack webhook] subscription cancel update failed:', err));
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Paystack webhook] Handler failed:', error);

    try {
      await prisma.webhookEvent.create({
        data: {
          externalId: String(event?.data?.id || event?.data?.reference || crypto.randomUUID()),
          provider: 'paystack',
          eventType: String(event?.event || 'unknown'),
          responseStatus: 500,
          error: error.message || 'Webhook handler failed',
        },
      });
    } catch {}

    return res.status(200).json({ success: true, handledWithError: true });
  }
});

export default router;
