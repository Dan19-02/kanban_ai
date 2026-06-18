import type { Prisma } from "@prisma/client";

/** Relations needed to serialize a board's full collaborative state. */
export const boardInclude = {
  actionItems: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
  comments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.BoardInclude;

export type BoardWithState = Prisma.BoardGetPayload<{ include: typeof boardInclude }>;
