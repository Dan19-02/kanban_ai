import { prisma } from "../prisma";

/**
 * Map of lowercased display-name → userId for everyone who can access a board
 * (owner, board members, and — if the board is in a project — the project owner
 * and members). Used to resolve @mentions and assignee names to real accounts so
 * we only notify people who actually have access.
 */
async function boardAudience(boardId: string): Promise<Map<string, string>> {
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      owner: { select: { name: true } },
      projectId: true,
      members: {
        select: { userId: true, displayName: true, user: { select: { name: true } } },
      },
    },
  });
  if (!board) return new Map();

  const map = new Map<string, string>();
  const add = (name: string | null | undefined, id: string) => {
    if (name) map.set(name.trim().toLowerCase(), id);
  };

  add(board.owner.name, board.ownerId);
  for (const m of board.members) add(m.displayName ?? m.user.name, m.userId);

  if (board.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: board.projectId },
      select: {
        ownerId: true,
        owner: { select: { name: true } },
        members: { select: { userId: true, user: { select: { name: true } } } },
      },
    });
    if (project) {
      add(project.owner.name, project.ownerId);
      for (const pm of project.members) add(pm.user.name, pm.userId);
    }
  }
  return map;
}

/** Which audience members are @mentioned in the text. Matches multi-word names. */
function resolveMentions(text: string, audience: Map<string, string>): Set<string> {
  const lower = text.toLowerCase();
  const ids = new Set<string>();
  for (const [name, userId] of audience) {
    if (lower.includes(`@${name}`)) ids.add(userId);
  }
  return ids;
}

const snippet = (text: string) => (text.length > 200 ? `${text.slice(0, 197)}…` : text);

interface MentionArgs {
  boardId: string;
  actionItemId?: string | null;
  actorId: string;
  actorName: string;
  text: string;
}

/** Create "mention" notifications for everyone @mentioned (except the author). */
export async function notifyMentions({ boardId, actionItemId, actorId, actorName, text }: MentionArgs) {
  const audience = await boardAudience(boardId);
  const ids = resolveMentions(text, audience);
  ids.delete(actorId);
  if (ids.size === 0) return;
  await prisma.notification.createMany({
    data: [...ids].map((userId) => ({
      userId,
      type: "mention",
      boardId,
      actionItemId: actionItemId ?? null,
      actorName,
      text: snippet(text),
    })),
  });
}

interface AssignmentArgs {
  boardId: string;
  actionItemId: string;
  assigneeName: string;
  title: string;
  actorId: string;
  actorName: string;
}

/** Notify a user when a task is assigned to them (if the name resolves to an account). */
export async function notifyAssignment({
  boardId,
  actionItemId,
  assigneeName,
  title,
  actorId,
  actorName,
}: AssignmentArgs) {
  if (!assigneeName || assigneeName.trim().toLowerCase() === "unassigned") return;
  const audience = await boardAudience(boardId);
  const userId = audience.get(assigneeName.trim().toLowerCase());
  if (!userId || userId === actorId) return; // unknown name, or assigning to yourself
  await prisma.notification.create({
    data: { userId, type: "assignment", boardId, actionItemId, actorName, text: snippet(title) },
  });
}

export function serializeNotification(n: {
  id: string;
  type: string;
  boardId: string | null;
  actionItemId: string | null;
  actorName: string;
  text: string;
  read: boolean;
  createdAt: Date;
}) {
  return {
    id: n.id,
    type: n.type as "mention" | "assignment",
    boardId: n.boardId,
    actionItemId: n.actionItemId,
    actorName: n.actorName,
    text: n.text,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
  };
}
