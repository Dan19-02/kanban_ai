import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../prisma";
import { env } from "../env";
import { asyncHandler, ApiError } from "../lib/http";
import { parse } from "../lib/validate";
import {
  createBoardSchema,
  updateBoardSchema,
  analyzeSchema,
  shareSchema,
  joinSchema,
  addMemberSchema,
  displayNameSchema,
  createActionItemSchema,
  updateActionItemSchema,
  createCommentSchema,
} from "../validation";
import { requireAuth } from "../auth/middleware";
import {
  requireBoardAccess,
  serializeBoard,
  serializeComment,
  resolveDisplayName,
  needsDisplayName,
  type BoardWithState,
} from "../services/boardAccess";
import { boardInclude } from "../services/boardInclude";
import { requireProjectOwner } from "../services/projectAccess";
import { analyzeTranscript } from "../services/ai";
import { notifyMentions, notifyAssignment } from "../services/notifications";
import { broadcastBoardState } from "../realtime";
import { analyzeLimiter } from "../middleware/rateLimit";
import { PLANS, transcriptionLimit, usedCount } from "../services/plans";

export const boardsRouter = Router();

// Every board route requires an authenticated user.
boardsRouter.use(requireAuth);

function shareUrl(req: { protocol: string; get(h: string): string | undefined }, boardId: string, token: string) {
  const base = env.APP_URL ?? `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/$/, "")}/board/${boardId}?token=${token}`;
}

/** Reload a board with its state relations (used after a mutation). */
async function reload(boardId: string): Promise<BoardWithState> {
  const board = await prisma.board.findUniqueOrThrow({
    where: { id: boardId },
    include: boardInclude,
  });
  return board;
}

// --- List & create ----------------------------------------------------------

boardsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const [owned, memberships] = await Promise.all([
      prisma.board.findMany({
        where: { ownerId: userId },
        include: { _count: { select: { actionItems: true, members: true } } },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.boardMember.findMany({
        where: { userId },
        include: {
          board: { include: { _count: { select: { actionItems: true, members: true } } } },
        },
        orderBy: { board: { updatedAt: "desc" } },
      }),
    ]);

    const list = [
      ...owned.map((b) => ({
        id: b.id,
        name: b.name,
        role: "OWNER" as const,
        projectId: b.projectId,
        hasAnalysis: b.summary != null,
        itemCount: b._count.actionItems,
        memberCount: b._count.members + 1, // +1 for the owner
        updatedAt: b.updatedAt.toISOString(),
      })),
      ...memberships.map((m) => ({
        id: m.board.id,
        name: m.board.name,
        role: m.role as "EDITOR" | "VIEWER",
        projectId: m.board.projectId,
        hasAnalysis: m.board.summary != null,
        itemCount: m.board._count.actionItems,
        memberCount: m.board._count.members + 1,
        updatedAt: m.board.updatedAt.toISOString(),
      })),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    res.json({ boards: list });
  }),
);

boardsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, projectId } = parse(createBoardSchema, req.body);
    // If filing the board under a project, confirm the caller owns it (404 on a
    // foreign/unknown id, so project existence is never leaked).
    if (projectId) await requireProjectOwner(req.user!.id, projectId);
    const board = await prisma.board.create({
      data: { name, ownerId: req.user!.id, projectId: projectId ?? null },
      include: boardInclude,
    });
    res.status(201).json({ board: serializeBoard(board, "OWNER") });
  }),
);

// --- Join via share link (must precede "/:id" routes) -----------------------

boardsRouter.post(
  "/join",
  asyncHandler(async (req, res) => {
    const { token } = parse(joinSchema, req.body);
    const userId = req.user!.id;

    const board = await prisma.board.findUnique({ where: { shareToken: token } });
    if (!board || !board.shareToken) {
      throw new ApiError(404, "This share link is invalid or has been disabled");
    }

    if (board.ownerId !== userId) {
      await prisma.boardMember.upsert({
        where: { boardId_userId: { boardId: board.id, userId } },
        update: {}, // keep an existing (possibly higher) role
        create: { boardId: board.id, userId, role: board.shareRole ?? "EDITOR" },
      });
    }

    res.json({ boardId: board.id });
  }),
);

// --- Single board: read / rename / delete -----------------------------------

boardsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const access = await requireBoardAccess(req.user!.id, req.params.id);
    res.json({
      board: serializeBoard(access.board, access.role),
      viewer: {
        displayName: resolveDisplayName(access, req.user!.name),
        needsDisplayName: needsDisplayName(access),
      },
    });
  }),
);

// Set the current user's display name on this board (prompted when joining).
boardsRouter.put(
  "/:id/display-name",
  asyncHandler(async (req, res) => {
    const access = await requireBoardAccess(req.user!.id, req.params.id);
    const { displayName } = parse(displayNameSchema, req.body);

    if (access.role === "OWNER") {
      // Owners are identified by their account name; nothing to store.
      res.json({ displayName: req.user!.name });
      return;
    }

    await prisma.boardMember.update({
      where: { boardId_userId: { boardId: req.params.id, userId: req.user!.id } },
      data: { displayName },
    });
    res.json({ displayName });
  }),
);

boardsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    const { name } = parse(updateBoardSchema, req.body);
    await prisma.board.update({ where: { id: req.params.id }, data: { name } });
    const board = await reload(req.params.id);
    res.json({ board: serializeBoard(board, "OWNER") });
  }),
);

boardsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    await prisma.board.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

// --- AI analysis ------------------------------------------------------------

boardsRouter.post(
  "/:id/analyze",
  analyzeLimiter,
  asyncHandler(async (req, res) => {
    const { role } = await requireBoardAccess(req.user!.id, req.params.id, "EDITOR");
    const { transcript } = parse(analyzeSchema, req.body);

    // --- Quota enforcement (a transcription = one AI analysis) ---
    const usage = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { plan: true, freeTranscriptionsUsed: true, periodTranscriptionsUsed: true },
    });
    const limit = transcriptionLimit(usage.plan);
    if (usedCount(usage) >= limit) {
      const planName = PLANS[usage.plan].name;
      throw new ApiError(
        402,
        usage.plan === "FREE"
          ? `You've used all ${limit} free transcriptions. Upgrade to a paid plan to keep going.`
          : `You've reached your ${planName} plan limit of ${limit} transcriptions this month. Upgrade for more.`,
      );
    }

    const analysis = await analyzeTranscript(transcript);

    // Re-analyzing regenerates the board: replace action items, keep comments.
    // The same transaction records one transcription against the user's quota.
    await prisma.$transaction([
      prisma.actionItem.deleteMany({ where: { boardId: req.params.id } }),
      prisma.board.update({
        where: { id: req.params.id },
        data: {
          transcript,
          summary: analysis.summary,
          keyDecisions: analysis.keyDecisions,
          risks: analysis.risks,
          dependencies: analysis.dependencies,
          blockers: analysis.blockers,
          openQuestions: analysis.openQuestions,
          sentimentScore: analysis.sentimentInfo.score,
          sentimentBreakdown: analysis.sentimentInfo.breakdown,
          actionItems: {
            create: analysis.actionItems.map((item, index) => ({
              title: item.title,
              assignee: item.assignee || "Unassigned",
              description: item.description,
              priority: item.priority,
              blockedBy: item.blockedBy ?? [],
              status: "pending",
              position: index,
            })),
          },
        },
      }),
      prisma.user.update({
        where: { id: req.user!.id },
        data:
          usage.plan === "FREE"
            ? { freeTranscriptionsUsed: { increment: 1 } }
            : { periodTranscriptionsUsed: { increment: 1 } },
      }),
    ]);

    const board = await reload(req.params.id);
    await broadcastBoardState(board.id);
    res.json({ board: serializeBoard(board, role) });
  }),
);

// --- Sharing ----------------------------------------------------------------

boardsRouter.post(
  "/:id/share",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    const { role } = parse(shareSchema, req.body);
    const token = crypto.randomBytes(24).toString("base64url");

    await prisma.board.update({
      where: { id: req.params.id },
      data: { shareToken: token, shareRole: role },
    });

    res.json({
      share: { enabled: true, role, token, url: shareUrl(req, req.params.id, token) },
    });
  }),
);

boardsRouter.delete(
  "/:id/share",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    await prisma.board.update({
      where: { id: req.params.id },
      data: { shareToken: null, shareRole: null },
    });
    res.json({ share: { enabled: false, role: null, token: null } });
  }),
);

// --- Members ----------------------------------------------------------------

boardsRouter.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    const board = await prisma.board.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    const members = [
      {
        userId: board.owner.id,
        name: board.owner.name,
        email: board.owner.email,
        role: "OWNER" as const,
        pending: false,
      },
      ...board.members.map((m) => ({
        userId: m.user.id,
        // Show the chosen board name; fall back to the account name until set.
        name: m.displayName ?? m.user.name,
        email: m.user.email,
        role: m.role as "EDITOR" | "VIEWER",
        // True until the member has opened the board and picked a display name.
        pending: !m.displayName,
      })),
    ];
    res.json({ members });
  }),
);

// Add an existing user to the board by email (owner only).
boardsRouter.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    const { email, role } = parse(addMemberSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      throw new ApiError(
        404,
        "No account uses that email yet. Ask them to sign up, or share the invite link instead.",
      );
    }
    const board = await prisma.board.findUniqueOrThrow({
      where: { id: req.params.id },
      select: { ownerId: true },
    });
    if (user.id === board.ownerId) {
      throw new ApiError(400, "That person already owns this board");
    }

    await prisma.boardMember.upsert({
      where: { boardId_userId: { boardId: req.params.id, userId: user.id } },
      update: { role },
      create: { boardId: req.params.id, userId: user.id, role },
    });
    res.status(201).json({ ok: true });
  }),
);

boardsRouter.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "OWNER");
    if (req.params.userId === req.user!.id) {
      throw new ApiError(400, "The owner cannot be removed from the board");
    }
    await prisma.boardMember
      .delete({ where: { boardId_userId: { boardId: req.params.id, userId: req.params.userId } } })
      .catch(() => {
        throw new ApiError(404, "That member is not on this board");
      });
    res.json({ ok: true });
  }),
);

// --- Action items -----------------------------------------------------------

boardsRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "EDITOR");
    const data = parse(createActionItemSchema, req.body);
    const max = await prisma.actionItem.aggregate({
      where: { boardId: req.params.id },
      _max: { position: true },
    });
    const created = await prisma.actionItem.create({
      data: {
        boardId: req.params.id,
        title: data.title,
        assignee: data.assignee,
        description: data.description,
        priority: data.priority,
        dueDate: data.dueDate,
        position: (max._max.position ?? -1) + 1,
      },
    });
    await notifyAssignment({
      boardId: req.params.id,
      actionItemId: created.id,
      assigneeName: data.assignee,
      title: data.title,
      actorId: req.user!.id,
      actorName: req.user!.name,
    }).catch(() => {});
    const board = await reload(req.params.id);
    await broadcastBoardState(board.id);
    res.status(201).json({ board: serializeBoard(board, "EDITOR") });
  }),
);

boardsRouter.patch(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "EDITOR");
    const data = parse(updateActionItemSchema, req.body);

    // Ensure the item belongs to this board before updating.
    const existing = await prisma.actionItem.findFirst({
      where: { id: req.params.itemId, boardId: req.params.id },
      select: { id: true, assignee: true, title: true },
    });
    if (!existing) throw new ApiError(404, "Action item not found");

    await prisma.actionItem.update({ where: { id: req.params.itemId }, data });
    // Notify the new assignee only when the assignment actually changed.
    if (data.assignee && data.assignee !== existing.assignee) {
      await notifyAssignment({
        boardId: req.params.id,
        actionItemId: req.params.itemId,
        assigneeName: data.assignee,
        title: data.title ?? existing.title,
        actorId: req.user!.id,
        actorName: req.user!.name,
      }).catch(() => {});
    }
    const board = await reload(req.params.id);
    await broadcastBoardState(board.id);
    res.json({ board: serializeBoard(board, "EDITOR") });
  }),
);

boardsRouter.delete(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id, "EDITOR");
    const result = await prisma.actionItem.deleteMany({
      where: { id: req.params.itemId, boardId: req.params.id },
    });
    if (result.count === 0) throw new ApiError(404, "Action item not found");
    const board = await reload(req.params.id);
    await broadcastBoardState(board.id);
    res.json({ ok: true });
  }),
);

// --- Comments ---------------------------------------------------------------

boardsRouter.post(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const access = await requireBoardAccess(req.user!.id, req.params.id, "EDITOR");
    const { text } = parse(createCommentSchema, req.body);
    const actorName = resolveDisplayName(access, req.user!.name);
    await prisma.comment.create({
      data: { boardId: req.params.id, authorId: req.user!.id, authorName: actorName, text },
    });
    // Best-effort: never let a notification failure break posting a comment.
    await notifyMentions({ boardId: req.params.id, actorId: req.user!.id, actorName, text }).catch(
      () => {},
    );
    const board = await reload(req.params.id);
    await broadcastBoardState(board.id);
    res.status(201).json({ board: serializeBoard(board, "EDITOR") });
  }),
);

// --- Task-level comments (per-action-item discussion / "Activity") -----------

/** Confirm an action item belongs to this board, or 404. */
async function requireItemOnBoard(boardId: string, itemId: string): Promise<void> {
  const item = await prisma.actionItem.findFirst({
    where: { id: itemId, boardId },
    select: { id: true },
  });
  if (!item) throw new ApiError(404, "Action item not found");
}

boardsRouter.get(
  "/:id/items/:itemId/comments",
  asyncHandler(async (req, res) => {
    await requireBoardAccess(req.user!.id, req.params.id); // VIEWER+
    await requireItemOnBoard(req.params.id, req.params.itemId);
    const comments = await prisma.comment.findMany({
      where: { actionItemId: req.params.itemId },
      orderBy: { createdAt: "asc" },
    });
    res.json({ comments: comments.map(serializeComment) });
  }),
);

boardsRouter.post(
  "/:id/items/:itemId/comments",
  asyncHandler(async (req, res) => {
    const access = await requireBoardAccess(req.user!.id, req.params.id, "EDITOR");
    const { text } = parse(createCommentSchema, req.body);
    await requireItemOnBoard(req.params.id, req.params.itemId);
    const actorName = resolveDisplayName(access, req.user!.name);
    await prisma.comment.create({
      data: {
        boardId: req.params.id,
        actionItemId: req.params.itemId,
        authorId: req.user!.id,
        authorName: actorName,
        text,
      },
    });
    await notifyMentions({
      boardId: req.params.id,
      actionItemId: req.params.itemId,
      actorId: req.user!.id,
      actorName,
      text,
    }).catch(() => {});
    const comments = await prisma.comment.findMany({
      where: { actionItemId: req.params.itemId },
      orderBy: { createdAt: "asc" },
    });
    res.status(201).json({ comments: comments.map(serializeComment) });
  }),
);
