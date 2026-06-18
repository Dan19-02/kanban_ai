import { Plan } from "@prisma/client";
import { env } from "../env";

export interface PlanInfo {
  id: Plan;
  name: string;
  /** Monthly price in USD (0 for free). */
  priceUsd: number;
  /** Transcriptions allowed per period; Infinity for unlimited. */
  limit: number;
  /** Free is a one-time lifetime allowance; paid plans renew monthly. */
  interval: "lifetime" | "month";
  tagline: string;
}

export const PLANS: Record<Plan, PlanInfo> = {
  FREE: { id: "FREE", name: "Free", priceUsd: 0, limit: 3, interval: "lifetime", tagline: "3 transcriptions to try it out" },
  STARTER: { id: "STARTER", name: "Starter", priceUsd: 10, limit: 30, interval: "month", tagline: "30 transcriptions per month" },
  PRO: { id: "PRO", name: "Pro", priceUsd: 30, limit: 100, interval: "month", tagline: "100 transcriptions per month" },
  UNLIMITED: { id: "UNLIMITED", name: "Unlimited", priceUsd: 99, limit: Infinity, interval: "month", tagline: "Unlimited transcriptions" },
};

export const PAID_PLANS: Plan[] = ["STARTER", "PRO", "UNLIMITED"];

/** The Stripe price id configured for a paid plan (undefined if not set up). */
export function priceIdForPlan(plan: Plan): string | undefined {
  switch (plan) {
    case "STARTER": return env.STRIPE_PRICE_STARTER;
    case "PRO": return env.STRIPE_PRICE_PRO;
    case "UNLIMITED": return env.STRIPE_PRICE_UNLIMITED;
    default: return undefined;
  }
}

/** Reverse lookup: which plan does a Stripe price id correspond to? */
export function planForPriceId(priceId: string): Plan | undefined {
  return PAID_PLANS.find((p) => priceIdForPlan(p) === priceId);
}

export function transcriptionLimit(plan: Plan): number {
  return PLANS[plan].limit;
}

type UsageFields = {
  plan: Plan;
  freeTranscriptionsUsed: number;
  periodTranscriptionsUsed: number;
};

/** How many transcriptions the user has consumed in their current allowance. */
export function usedCount(user: UsageFields): number {
  return user.plan === "FREE" ? user.freeTranscriptionsUsed : user.periodTranscriptionsUsed;
}
