import type { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma";
import { verifyAuthToken } from "./jwt";
import { AUTH_COOKIE } from "./cookies";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

// Augment Express' Request so route handlers get a typed `req.user`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Reads and verifies the auth cookie, returning the matching user or null.
 * Shared by the HTTP middleware and the Socket.IO handshake.
 */
export async function authenticateToken(
  token: string | undefined,
): Promise<AuthUser | null> {
  if (!token) return null;
  const payload = verifyAuthToken(token);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, name: true },
  });
  return user;
}

/** Populates req.user when a valid cookie is present; never rejects. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await authenticateToken(req.cookies?.[AUTH_COOKIE]);
  if (user) req.user = user;
  next();
}

/** Rejects with 401 unless a valid auth cookie is present. */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await authenticateToken(req.cookies?.[AUTH_COOKIE]);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.user = user;
  next();
}
