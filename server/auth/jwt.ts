import jwt from "jsonwebtoken";
import { env } from "../env";

const TOKEN_TTL = "7d";
// Pin the signing algorithm on both sign and verify so a token can never be
// accepted under a different (or "none") algorithm.
const ALGORITHM = "HS256" as const;

export interface AuthTokenPayload {
  /** User id */
  sub: string;
  email: string;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: TOKEN_TTL,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof (decoded as any).sub === "string" &&
      typeof (decoded as any).email === "string"
    ) {
      return { sub: (decoded as any).sub, email: (decoded as any).email };
    }
    return null;
  } catch {
    return null;
  }
}
