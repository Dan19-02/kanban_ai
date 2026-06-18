import { prisma } from "../prisma";
import { ApiError } from "../lib/http";
import { boardInclude, type BoardWithState } from "./boardInclude";

export type { BoardWithState };

export type EffectiveRole = "OWNER" | "EDITOR" | "VIEWER";

export interface BoardAccess {
  board: BoardWithState;
  role: EffectiveRole;
  /** The member's chosen board display name (null for owner or unset members). */
  displayName: string | null;
}

const RANK: Record<EffectiveRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

/**
 * Resolve a user's effective role on a board, or null if they have no access.
 * The owner always outranks any membership row.
 */
export async function getBoardAccess(
  userId: string,
  boardId: string,
): Promise<BoardAccess | null> {
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    include: boardInclude,
  });
  if (!board) return null;

  if (board.ownerId === userId) return { board, role: "OWNER", displayName: null };

  const membership = await prisma.boardMember.findUnique({
    where: { boardId_userId: { boardId, userId } },
    select: { role: true, displayName: true },
  });
  if (!membership) return null;

  return { board, role: membership.role as EffectiveRole, displayName: membership.displayName };
}

/**
 * Like getBoardAccess, but throws 404 (no access / missing) or 403 (insufficient
 * role). We return 404 rather than 403 for "no access at all" so we don't leak
 * the existence of boards a user can't see.
 */
export async function requireBoardAccess(
  userId: string,
  boardId: string,
  minRole: EffectiveRole = "VIEWER",
): Promise<BoardAccess> {
  const access = await getBoardAccess(userId, boardId);
  if (!access) throw new ApiError(404, "Board not found");
  if (RANK[access.role] < RANK[minRole]) {
    throw new ApiError(403, "You do not have permission to do that");
  }
  return access;
}

/** The name to attribute to a viewer on a board (owner uses their account name). */
export function resolveDisplayName(access: BoardAccess, accountName: string): string {
  return access.role === "OWNER" ? accountName : access.displayName ?? accountName;
}

/** Whether a member still needs to choose a board display name. */
export function needsDisplayName(access: BoardAccess): boolean {
  return access.role !== "OWNER" && !access.displayName;
}

// --- Serialization (DB shape -> client/API shape) ---

export function serializeActionItem(item: BoardWithState["actionItems"][number]) {
  return {
    id: item.id,
    title: item.title,
    assignee: item.assignee,
    description: item.description ?? undefined,
    status: item.status as "pending" | "completed",
    priority: (item.priority ?? undefined) as "High" | "Medium" | "Low" | undefined,
    dueDate: item.dueDate ?? undefined,
    blockedBy: item.blockedBy ?? [],
  };
}

export function serializeComment(comment: BoardWithState["comments"][number]) {
  return {
    id: comment.id,
    text: comment.text,
    author: comment.authorName,
    timestamp: comment.createdAt.toISOString(),
  };
}

/**
 * The collaborative document state that is broadcast to everyone in a board's
 * room. Contains no per-user secrets (e.g. no share token).
 */
export function serializeBoardState(board: BoardWithState) {
  return {
    summary: board.summary ?? "",
    keyDecisions: board.keyDecisions,
    risks: board.risks ?? [],
    dependencies: board.dependencies ?? [],
    sentimentInfo:
      board.sentimentScore != null
        ? { score: board.sentimentScore, breakdown: board.sentimentBreakdown ?? "" }
        : null,
    actionItems: board.actionItems.map(serializeActionItem),
    comments: board.comments.map(serializeComment),
  };
}

/**
 * Board metadata + state for a specific viewer. The share token is only included
 * for the owner, since anyone holding it gains access.
 */
export function serializeBoard(board: BoardWithState, role: EffectiveRole) {
  const isOwner = role === "OWNER";
  return {
    id: board.id,
    name: board.name,
    ownerId: board.ownerId,
    role,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    share: {
      enabled: board.shareToken != null,
      role: board.shareRole,
      // Only the owner can read the actual token (used to build the link).
      token: isOwner ? board.shareToken : null,
    },
    ...serializeBoardState(board),
  };
}
