import type { Project } from "@prisma/client";
import { prisma } from "../prisma";
import { ApiError } from "../lib/http";

export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER";

const RANK: Record<ProjectRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

export interface ProjectAccess {
  project: Project;
  role: ProjectRole;
}

/**
 * Resolve a user's effective role on a project, or null if they have none.
 * The owner outranks any membership row. Members are granted access via a share
 * link or an explicit invite (mirrors how boards are shared).
 */
export async function getProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccess | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  if (project.ownerId === userId) return { project, role: "OWNER" };

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  return { project, role: membership.role as ProjectRole };
}

/**
 * Like getProjectAccess but throws 404 (no access / missing — so we never leak
 * a project's existence) or 403 (insufficient role).
 */
export async function requireProjectAccess(
  userId: string,
  projectId: string,
  minRole: ProjectRole = "VIEWER",
): Promise<ProjectAccess> {
  const access = await getProjectAccess(userId, projectId);
  if (!access) throw new ApiError(404, "Project not found");
  if (RANK[access.role] < RANK[minRole]) {
    throw new ApiError(403, "You do not have permission to do that");
  }
  return access;
}

/** Owner-only access (rename, delete, sharing, member management). */
export async function requireProjectOwner(
  userId: string,
  projectId: string,
): Promise<Project> {
  const access = await requireProjectAccess(userId, projectId, "OWNER");
  return access.project;
}

/** API shape for a project. The share token is only revealed to the owner. */
export function serializeProject(project: Project, role: ProjectRole = "OWNER") {
  const isOwner = role === "OWNER";
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? undefined,
    color: project.color,
    archived: project.archived,
    role,
    share: {
      enabled: project.shareToken != null,
      role: project.shareRole,
      token: isOwner ? project.shareToken : null,
    },
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
