import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";
import { env, isProduction } from "../env";

// Origins allowed to make browser (credentialed) requests to the API and to
// open a Socket.IO connection. In production this is the deployed frontend
// (APP_URL). In development we also allow the Vite dev server so the app can be
// run without the proxy if desired. 5173 is Vite's default; 3001 is the port
// this project's dev server is run on.
const devPorts = [5173, 3001];
const devOrigins = devPorts.flatMap((p) => [
  `http://localhost:${p}`,
  `http://127.0.0.1:${p}`,
]);

export const allowedOrigins: string[] = [
  ...(env.APP_URL ? [env.APP_URL.replace(/\/$/, "")] : []),
  ...(isProduction ? [] : devOrigins),
];

/** CORS options for the REST API (credentialed, strict allow-list). */
export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header = same-origin navigation or a non-browser client (curl,
    // health checks, server-to-server). Allow those; the auth cookie still
    // gates anything sensitive.
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    // Disallowed origin: respond without CORS headers so the browser blocks it.
    callback(null, false);
  },
  credentials: true,
};

/**
 * Origin value for Socket.IO's CORS. An explicit allow-list in production (and
 * dev), never a credentialed wildcard. `false` disables cross-origin entirely
 * when no origins are configured.
 */
export const socketCorsOrigin: string[] | false =
  allowedOrigins.length > 0 ? allowedOrigins : false;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Defense-in-depth CSRF guard. Because the auth cookie is SameSite=None in
 * production, the browser attaches it to cross-site requests, so we validate the
 * Origin header on state-changing methods (OWASP-recommended). Requests pass if:
 *   - they have no Origin header (non-browser clients, server-to-server), or
 *   - the Origin is allow-listed (the configured frontend), or
 *   - the Origin is same-origin as the host being served (monolith mode).
 * Cross-site form posts — which bypass CORS preflight — are rejected here.
 */
export function csrfOriginGuard(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  // Bearer-token requests carry their credential in a header the browser never
  // attaches automatically cross-site, so they can't be forged via CSRF.
  if (req.headers.authorization?.startsWith("Bearer ")) return next();

  const origin = req.get("origin");
  if (!origin || allowedOrigins.includes(origin)) return next();

  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch {
    // Malformed Origin header — fall through to rejection.
  }

  res.status(403).json({ error: "Cross-origin request blocked" });
}
