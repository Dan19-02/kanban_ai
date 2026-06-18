import { Router } from "express";
import { prisma } from "../prisma";
import { env } from "../env";
import { asyncHandler, ApiError } from "../lib/http";
import { parse } from "../lib/validate";
import { checkoutSchema } from "../validation";
import { requireAuth } from "../auth/middleware";
import { serializeUser } from "../services/users";
import { PLANS, priceIdForPlan } from "../services/plans";
import {
  billingEnabled,
  createCheckoutSession,
  createPortalSession,
} from "../services/billing";

export const billingRouter = Router();

billingRouter.use(requireAuth);

function baseUrl(req: { protocol: string; get(h: string): string | undefined }): string {
  return (env.APP_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

/** Catalog of plans for the pricing page. */
billingRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const plans = Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      priceUsd: p.priceUsd,
      limit: p.limit === Infinity ? null : p.limit,
      interval: p.interval,
      tagline: p.tagline,
      // A paid plan is only purchasable once its Stripe price id is configured.
      purchasable: p.id !== "FREE" && !!priceIdForPlan(p.id),
    }));
    res.json({ plans, billingEnabled: billingEnabled() });
  }),
);

/** The current user's plan, usage, and management capability. */
billingRouter.get(
  "/subscription",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    res.json({
      ...serializeUser(user),
      canManage: !!user.stripeCustomerId,
      billingEnabled: billingEnabled(),
    });
  }),
);

/** Start a Stripe Checkout session for a paid plan. */
billingRouter.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    const { plan } = parse(checkoutSchema, req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    const url = await createCheckoutSession(user, plan, baseUrl(req));
    res.json({ url });
  }),
);

/** Open the Stripe Billing Portal to manage or cancel a subscription. */
billingRouter.post(
  "/portal",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    const url = await createPortalSession(user, baseUrl(req));
    res.json({ url });
  }),
);
