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
    select: { id: true, email: true, name: true, tokenVersion: true },
  });
  // A token signed before the user's last sign-out is no longer valid.
  if (!user || user.tokenVersion !== payload.tv) return null;
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Extract the auth token from the request. Prefers the `Authorization: Bearer`
 * header (works cross-origin on every device, incl. mobile where third-party
 * cookies are blocked) and falls back to the httpOnly cookie (same-origin).
 */
export function getRequestToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return req.cookies?.[AUTH_COOKIE];
}

// Both middlewares below hand a failed lookup (for example an unreachable
// database) to the error handler. Express 4 does not catch a rejected promise
// from a middleware, and an unhandled one would stop the whole process.

/** Populates req.user when a valid token is present; never answers 401. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await authenticateToken(getRequestToken(req));
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Rejects with 401 unless a valid token (Bearer header or cookie) is present. */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await authenticateToken(getRequestToken(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
