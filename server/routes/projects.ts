import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { parse } from "../lib/validate";
import { createProjectSchema, updateProjectSchema, addMemberSchema } from "../validation";
import { requireAuth } from "../auth/middleware";
import {
  requireProjectAccess,
  requireProjectOwner,
  serializeProject,
  type ProjectRole,
} from "../services/projectAccess";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

/** Boards-with-counts needed to compute a project's rollup numbers. */
const listInclude = {
  boards: {
    select: {
      updatedAt: true,
      _count: { select: { actionItems: { where: { status: "pending" } } } },
    },
  },
} satisfies Prisma.ProjectInclude;

type ProjectForSummary = Prisma.ProjectGetPayload<{ include: typeof listInclude }>;

function summarize(project: ProjectForSummary, role: ProjectRole) {
  const boardCount = project.boards.length;
  const openTaskCount = project.boards.reduce((sum, b) => sum + b._count.actionItems, 0);
  const latest = project.boards.reduce<Date>(
    (max, b) => (b.updatedAt > max ? b.updatedAt : max),
    project.updatedAt,
  );
  return {
    ...serializeProject(project, role),
    boardCount,
    openTaskCount,
    updatedAt: latest.toISOString(),
  };
}

/** A board's lightweight summary as shown inside a project. */
function boardSummary(
  b: {
    id: string;
    name: string;
    summary: string | null;
    updatedAt: Date;
    _count: { actionItems: number; members: number };
  },
  role: ProjectRole,
) {
  return {
    id: b.id,
    name: b.name,
    role,
    hasAnalysis: b.summary != null,
    itemCount: b._count.actionItems,
    memberCount: b._count.members + 1, // +1 for the owner
    updatedAt: b.updatedAt.toISOString(),
  };
}

// --- List & create ----------------------------------------------------------

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const [owned, memberships] = await Promise.all([
      prisma.project.findMany({
        where: { ownerId: userId },
        orderBy: [{ archived: "asc" }, { createdAt: "desc" }],
        include: listInclude,
      }),
      prisma.projectMember.findMany({
        where: { userId },
        include: { project: { include: listInclude } },
      }),
    ]);

    const list = [
      ...owned.map((p) => summarize(p, "OWNER")),
      ...memberships.map((m) => summarize(m.project, m.role as ProjectRole)),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    res.json({ projects: list });
  }),
);

projectsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, description, color } = parse(createProjectSchema, req.body);
    const project = await prisma.project.create({
      data: { name, description, color, ownerId: req.user!.id },
    });
    res
      .status(201)
      .json({ project: { ...serializeProject(project, "OWNER"), boardCount: 0, openTaskCount: 0 } });
  }),
);

// --- Single project: read / update / delete ---------------------------------

projectsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { project, role } = await requireProjectAccess(req.user!.id, req.params.id);
    const boards = await prisma.board.findMany({
      where: { projectId: project.id },
      include: { _count: { select: { actionItems: true, members: true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json({
      project: serializeProject(project, role),
      boards: boards.map((b) => boardSummary(b, role)),
    });
  }),
);

projectsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    await requireProjectOwner(req.user!.id, req.params.id);
    const data = parse(updateProjectSchema, req.body);
    const project = await prisma.project.update({ where: { id: req.params.id }, data });
    res.json({ project: serializeProject(project, "OWNER") });
  }),
);

projectsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await requireProjectOwner(req.user!.id, req.params.id);
    const boardCount = await prisma.board.count({ where: { projectId: req.params.id } });
    if (boardCount > 0) {
      throw new ApiError(
        400,
        "This project still has boards. Move or delete them before deleting the project.",
      );
    }
    await prisma.project.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

// --- Cross-board task rollup ------------------------------------------------

projectsRouter.get(
  "/:id/tasks",
  asyncHandler(async (req, res) => {
    await requireProjectAccess(req.user!.id, req.params.id);
    const boards = await prisma.board.findMany({
      where: { projectId: req.params.id },
      select: {
        id: true,
        name: true,
        actionItems: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: { createdAt: "asc" },
    });

    const tasks = boards.flatMap((b) =>
      b.actionItems.map((it) => ({
        id: it.id,
        boardId: b.id,
        boardName: b.name,
        title: it.title,
        assignee: it.assignee,
        status: it.status as "pending" | "completed",
        priority: (it.priority ?? undefined) as "High" | "Medium" | "Low" | undefined,
        dueDate: it.dueDate ?? undefined,
        blockedBy: it.blockedBy ?? [],
      })),
    );

    res.json({ tasks, boards: boards.map((b) => ({ id: b.id, name: b.name })) });
  }),
);

// --- Members (owner only) ---------------------------------------------------

projectsRouter.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    await requireProjectOwner(req.user!.id, req.params.id);
    const project = await prisma.project.findUniqueOrThrow({
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
      { userId: project.owner.id, name: project.owner.name, email: project.owner.email, role: "OWNER" as const },
      ...project.members.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role as "EDITOR" | "VIEWER",
      })),
    ];
    res.json({ members });
  }),
);

projectsRouter.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    await requireProjectOwner(req.user!.id, req.params.id);
    const { email, role } = parse(addMemberSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      throw new ApiError(
        404,
        "No account uses that email yet. Ask them to sign up first, then add them here.",
      );
    }
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: req.params.id },
      select: { ownerId: true },
    });
    if (user.id === project.ownerId) {
      throw new ApiError(400, "That person already owns this project");
    }

    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: req.params.id, userId: user.id } },
      update: { role },
      create: { projectId: req.params.id, userId: user.id, role },
    });
    res.status(201).json({ ok: true });
  }),
);

projectsRouter.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    await requireProjectOwner(req.user!.id, req.params.id);
    if (req.params.userId === req.user!.id) {
      throw new ApiError(400, "The owner cannot be removed from the project");
    }
    await prisma.projectMember
      .delete({ where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } } })
      .catch(() => {
        throw new ApiError(404, "That member is not on this project");
      });
    res.json({ ok: true });
  }),
);
