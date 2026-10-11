import "dotenv/config"; // Load .env before anything reads process.env.
import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import http from "http";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cors from "cors";
import compression from "compression";
import { Prisma } from "@prisma/client";

import { env, isProduction } from "./env";
import { prisma } from "./prisma";
import { ApiError } from "./lib/http";
import { corsOptions, csrfOriginGuard, socketCorsOrigin } from "./lib/cors";
import { apiLimiter } from "./middleware/rateLimit";
import { authRouter } from "./routes/auth";
import { boardsRouter } from "./routes/boards";
import { projectsRouter } from "./routes/projects";
import { notificationsRouter } from "./routes/notifications";
import { billingRouter } from "./routes/billing";
import { constructWebhookEvent, handleWebhookEvent } from "./services/billing";
import { initRealtime } from "./realtime";

// Prisma error codes that mean the database could not be reached or timed out.
const DATABASE_DOWN_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

function isDatabaseDown(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && DATABASE_DOWN_CODES.has(err.code))
  );
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // Behind a reverse proxy (Render, Nginx, etc.) trust X-Forwarded-* so
  // secure cookies, client IPs (rate limiting) and protocol detection work.
  if (isProduction) app.set("trust proxy", 1);

  if (isProduction && !env.APP_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      "⚠️  APP_URL is not set. The frontend will be blocked by CORS and " +
        "share/redirect links will fall back to request headers. " +
        "Set APP_URL to your frontend origin.",
    );
  }

  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:"],
              fontSrc: ["'self'", "data:"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'self'"],
            },
          }
        : false, // Vite's dev client needs inline scripts / eval.
    }),
  );
  app.use(compression()); // gzip API/JSON responses to cut payload size + latency.
  app.use(cookieParser());

  // Stripe webhook must receive the RAW body for signature verification, so it
  // is registered before the JSON body parser and before the rate limiter.
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") {
        res.status(400).send("Missing stripe-signature header");
        return;
      }
      let event;
      try {
        event = constructWebhookEvent(req.body as Buffer, signature);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Stripe webhook verification failed:", (err as Error).message);
        res.status(400).send("Invalid signature");
        return;
      }
      try {
        await handleWebhookEvent(event);
        res.json({ received: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Stripe webhook handler error:", err);
        res.status(500).send("Webhook handler failed");
      }
    },
  );

  // Cross-origin access for the separately-deployed frontend. Strict, credentialed
  // allow-list (see lib/cors). Registered after the webhook (server-to-server) and
  // before the body parser so preflight requests are answered cheaply.
  app.use("/api", cors(corsOptions));

  // CSRF defense-in-depth: validate Origin on state-changing requests. Runs
  // after the webhook (registered above, server-to-server) so Stripe is exempt.
  app.use("/api", csrfOriginGuard);

  app.use(express.json({ limit: "1mb" }));

  // --- API ---
  // Liveness only: it says the process is up and which commit it runs. The host
  // polls it, so it never touches the database.
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) }),
  );

  app.use("/api", apiLimiter);

  // Readiness: can the server reach its database right now? Not polled; open it
  // by hand when sign-in fails to tell an outage from a bug. It sits behind the
  // rate limiter because each call runs a query.
  app.get("/api/health/db", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Database check failed:", err);
      res.status(503).json({ ok: false, error: "The database is not reachable." });
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/boards", boardsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/billing", billingRouter);

  // Unknown API route -> JSON 404 (so the SPA fallback never swallows it).
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // --- Realtime ---
  initRealtime(httpServer, socketCorsOrigin);

  // --- Frontend ---
  // Serve an embedded frontend build if one is present (single-service /
  // monolith deployments). In the two-service setup the frontend is a separate
  // static site, so this is skipped and the backend runs API-only.
  const distPath = path.join(process.cwd(), "dist/public");
  const indexHtml = path.join(distPath, "index.html");
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(indexHtml));
  } else {
    app.get("/", (_req, res) => res.json({ service: "kanban-ai-backend", status: "ok" }));
  }

  // --- Central error handler (must be last, 4-arg signature) ---
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // A request body the JSON parser refused (malformed or too large) is the
    // caller's mistake, not a server fault.
    const status = (err as { status?: unknown } | null)?.status;
    const fromBodyParser = typeof (err as { type?: unknown } | null)?.type === "string";
    if (fromBodyParser && typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({
        error: status === 413 ? "That request is too large." : "The request could not be read.",
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error("Unhandled error:", err);
    if (isDatabaseDown(err)) {
      res
        .status(503)
        .json({ error: "The service cannot reach its database right now. Please try again shortly." });
      return;
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  httpServer.listen(env.PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}

// A promise rejected outside a request handler (a socket event, a background
// task) is logged and the server keeps running. Left to the default, it would
// stop the process and drop every connected user.
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled promise rejection:", reason);
});

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});
