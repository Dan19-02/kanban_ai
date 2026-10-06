import type { Plan } from "@prisma/client";
import { prisma } from "../prisma";
import { transcriptionLimit } from "./plans";

/**
 * Take one transcription from a user's allowance before the AI is called.
 * Returns false when none is left.
 *
 * It is one conditional UPDATE, so the database decides who gets the last one.
 * Checking the count first and adding to it afterwards let requests sent in
 * parallel all pass the check before any of them had been counted.
 */
export async function reserveTranscription(userId: string, plan: Plan): Promise<boolean> {
  const limit = transcriptionLimit(plan);
  const capped = limit !== Infinity;
  const taken =
    plan === "FREE"
      ? await prisma.user.updateMany({
          where: { id: userId, ...(capped ? { freeTranscriptionsUsed: { lt: limit } } : {}) },
          data: { freeTranscriptionsUsed: { increment: 1 } },
        })
      : await prisma.user.updateMany({
          where: { id: userId, ...(capped ? { periodTranscriptionsUsed: { lt: limit } } : {}) },
          data: { periodTranscriptionsUsed: { increment: 1 } },
        });
  return taken.count > 0;
}

/**
 * Hand a reserved transcription back when the analysis produced nothing. The
 * count never goes below zero: a billing period may have reset it meanwhile.
 */
export async function releaseTranscription(userId: string, plan: Plan): Promise<void> {
  if (plan === "FREE") {
    await prisma.user.updateMany({
      where: { id: userId, freeTranscriptionsUsed: { gt: 0 } },
      data: { freeTranscriptionsUsed: { decrement: 1 } },
    });
  } else {
    await prisma.user.updateMany({
      where: { id: userId, periodTranscriptionsUsed: { gt: 0 } },
      data: { periodTranscriptionsUsed: { decrement: 1 } },
    });
  }
}
