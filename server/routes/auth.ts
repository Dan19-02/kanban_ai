import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { parse } from "../lib/validate";
import { registerSchema, loginSchema } from "../validation";
import { hashPassword, verifyPassword } from "../auth/password";
import { signAuthToken } from "../auth/jwt";
import { setAuthCookie, clearAuthCookie } from "../auth/cookies";
import { requireAuth, authenticateToken, getRequestToken } from "../auth/middleware";
import { authLimiter } from "../middleware/rateLimit";
import { serializeUser } from "../services/users";
import { disconnectUser } from "../realtime";

export const authRouter = Router();

// A valid bcrypt hash of a random string. Used to run a comparison for
// non-existent users so login timing doesn't reveal which emails are registered.
const DUMMY_HASH = "$2b$12$xh2Bm.GdNiQfMLTpyv6qtuhCv/zndrzNoqKknuha2013HOlaASJ7C";

authRouter.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { name, email, password } = parse(registerSchema, req.body);

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await prisma.user.create({ data: { name, email, passwordHash } });
    } catch (err) {
      // Unique constraint on email.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ApiError(409, "An account with this email already exists");
      }
      throw err;
    }

    const token = signAuthToken({ sub: user.id, email: user.email, tv: user.tokenVersion });
    setAuthCookie(res, token);
    // Return the token in the body too, so the SPA can authenticate cross-origin
    // via an Authorization header (mobile blocks third-party cookies).
    res.status(201).json({ user: serializeUser(user), token });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    // Always run a comparison to keep timing roughly constant even when the
    // user doesn't exist, then return the same error for either failure.
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, DUMMY_HASH);

    if (!user || !ok) {
      throw new ApiError(401, "Invalid email or password");
    }

    const token = signAuthToken({ sub: user.id, email: user.email, tv: user.tokenVersion });
    setAuthCookie(res, token);
    res.json({ user: serializeUser(user), token });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    // Retire every token issued to this user so far, so a copied token stops
    // working the moment they sign out (this signs the account out everywhere).
    // Signing out must still succeed with an expired token or while the database
    // is unreachable, so this step is best effort.
    try {
      const user = await authenticateToken(getRequestToken(req));
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { tokenVersion: { increment: 1 } },
        });
        disconnectUser(user.id);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Could not retire tokens on sign-out:", err);
    }
    clearAuthCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    res.json({ user: serializeUser(user) });
  }),
);
