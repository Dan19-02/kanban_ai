import type { Prisma } from "@prisma/client";

/** Relations needed to serialize a board's full collaborative state. */
export const boardInclude = {
  actionItems: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
  // Board-level chat only — task-level comments (actionItemId set) are fetched
  // separately by the task's Activity tab.
  comments: { where: { actionItemId: null }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.BoardInclude;

export type BoardWithState = Prisma.BoardGetPayload<{ include: typeof boardInclude }>;
