import type { User } from "@prisma/client";
import { transcriptionLimit, usedCount } from "./plans";

/**
 * Public, client-safe representation of a user — never includes the password
 * hash or raw Stripe ids. Includes the user's plan and current usage so the
 * frontend can render quota indicators.
 */
export function serializeUser(user: User) {
  const limit = transcriptionLimit(user.plan);
  const used = usedCount(user);
  const unlimited = limit === Infinity;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    usage: {
      used,
      limit: unlimited ? null : limit,
      remaining: unlimited ? null : Math.max(0, limit - used),
      unlimited,
    },
    subscriptionStatus: user.subscriptionStatus ?? null,
    currentPeriodEnd: user.currentPeriodEnd?.toISOString() ?? null,
  };
}

export type SerializedUser = ReturnType<typeof serializeUser>;
