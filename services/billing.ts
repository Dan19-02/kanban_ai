import Stripe from "stripe";
import type { User } from "@prisma/client";
import { env } from "../env";
import { prisma } from "../prisma";
import { ApiError } from "../lib/http";
import { priceIdForPlan, planForPriceId } from "./plans";

/** Whether Stripe is configured at all. */
export function billingEnabled(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

let stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new ApiError(503, "Billing is not configured. Set STRIPE_SECRET_KEY on the server.");
  }
  if (!stripe) stripe = new Stripe(env.STRIPE_SECRET_KEY);
  return stripe;
}

const customerIdOf = (sub: Stripe.Subscription): string =>
  typeof sub.customer === "string" ? sub.customer : sub.customer.id;

/**
 * The current period end timestamp. Stripe moved this field from the
 * subscription to the subscription item in 2025 API versions, so we read
 * whichever is present (cast to avoid version-specific type drift).
 */
function periodEnd(sub: Stripe.Subscription): Date | null {
  const anySub = sub as any;
  const ts = anySub.current_period_end ?? anySub.items?.data?.[0]?.current_period_end;
  return typeof ts === "number" ? new Date(ts * 1000) : null;
}

/** Find or lazily create the Stripe customer for a user. */
async function ensureCustomer(user: User): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await getStripe().customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id },
  });
  await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/** Create a Stripe Checkout session for a paid plan; returns the redirect URL. */
export async function createCheckoutSession(
  user: User,
  plan: "STARTER" | "PRO" | "UNLIMITED",
  baseUrl: string,
): Promise<string> {
  const priceId = priceIdForPlan(plan);
  if (!priceId) throw new ApiError(400, `The ${plan} plan isn't available for purchase yet.`);

  const customerId = await ensureCustomer(user);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    allow_promotion_codes: true,
    success_url: `${baseUrl}/billing?status=success`,
    cancel_url: `${baseUrl}/billing?status=cancel`,
  });
  if (!session.url) throw new ApiError(502, "Could not start checkout. Please try again.");
  return session.url;
}

/** Create a Stripe Billing Portal session so users can manage/cancel. */
export async function createPortalSession(user: User, baseUrl: string): Promise<string> {
  if (!user.stripeCustomerId) {
    throw new ApiError(400, "You don't have a subscription to manage yet.");
  }
  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${baseUrl}/billing`,
  });
  return session.url;
}

/** Verify and parse a webhook payload. */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new ApiError(503, "Webhook secret is not configured.");
  }
  return getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}

/** Apply a subscription's current state to the matching user. */
async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerIdOf(sub) } });
  if (!user) return;

  const priceId = sub.items.data[0]?.price.id;
  const plan = priceId ? planForPriceId(priceId) : undefined;
  const active = sub.status === "active" || sub.status === "trialing";
  const newPeriodEnd = periodEnd(sub);

  // Reset the period quota only when the billing period actually advances,
  // so routine subscription updates can't be abused to refill quota.
  const periodAdvanced =
    !!newPeriodEnd &&
    (!user.currentPeriodEnd || newPeriodEnd.getTime() !== user.currentPeriodEnd.getTime());

  await prisma.user.update({
    where: { id: user.id },
    data: {
      plan: active && plan ? plan : "FREE",
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentPeriodEnd: newPeriodEnd,
      ...(periodAdvanced ? { periodTranscriptionsUsed: 0 } : {}),
    },
  });
}

/** Downgrade a user to FREE when their subscription ends. */
async function cancelSubscription(sub: Stripe.Subscription): Promise<void> {
  const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerIdOf(sub) } });
  if (!user) return;
  await prisma.user.update({
    where: { id: user.id },
    data: { plan: "FREE", subscriptionStatus: sub.status, stripeSubscriptionId: null },
  });
}

/** Route a verified webhook event to the right handler. */
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const sub = await getStripe().subscriptions.retrieve(session.subscription as string);
        await applySubscription(sub);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await applySubscription(event.data.object as Stripe.Subscription);
      break;
    case "customer.subscription.deleted":
      await cancelSubscription(event.data.object as Stripe.Subscription);
      break;
    default:
      // Ignore other event types.
      break;
  }
}
