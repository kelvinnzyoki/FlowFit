import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY env var is required');
}

// Single shared Stripe client — never instantiate elsewhere
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
  typescript: true,
});

/**
 * Ensure a Stripe customer exists for this user.
 * Creates one if not present and persists the ID.
 */
export async function getOrCreateStripeCustomer(
  prisma: any,
  userId: string,
  email: string,
  name?: string | null,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });

  if (user?.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email,
    name: name ?? undefined,
    metadata: { userId },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

/**
 * Verify a Stripe webhook signature.
 * Returns the parsed event or throws on failure.
 */
export function constructWebhookEvent(
  payload: Buffer,
  signature: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET env var is required');
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

export default stripe;