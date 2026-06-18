import type { CookieOptions, Response } from "express";
import { env, isProduction } from "../env";

export const AUTH_COOKIE = "auth_token";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// In production the frontend (static site) and backend (API) are served from
// different origins, so the auth cookie travels cross-site and must be
// SameSite=None + Secure to be sent at all. In development the Vite dev-server
// proxy keeps everything same-origin, so Lax works over plain HTTP.
//
// COOKIE_DOMAIN (optional) scopes the cookie to a shared parent domain when the
// two services sit on sibling subdomains (e.g. api/app of yourdomain.com),
// which makes it first-party and avoids browser third-party-cookie blocking.
const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: isProduction ? "none" : "lax",
  secure: isProduction,
  domain: env.COOKIE_DOMAIN,
  path: "/",
};

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE, token, { ...baseCookieOptions, maxAge: SEVEN_DAYS_MS });
}

export function clearAuthCookie(res: Response): void {
  // clearCookie must use the same attributes (sameSite/secure/domain/path) the
  // cookie was set with, or the browser won't remove it.
  res.clearCookie(AUTH_COOKIE, baseCookieOptions);
}
