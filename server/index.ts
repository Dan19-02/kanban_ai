import "dotenv/config"; // Load .env before anything reads process.env.
import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import http from "http";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cors from "cors";
import compression from "compression";

import { env, isProduction } from "./env";
import { ApiError } from "./lib/http";
import { corsOptions, csrfOriginGuard, socketCorsOrigin } from "./lib/cors";
import { apiLimiter } from "./middleware/rateLimit";
import { authRouter } from "./routes/auth";
import { boardsRouter } from "./routes/boards";
import { billingRouter } from "./routes/billing";
import { constructWebhookEvent, handleWebhookEvent } from "./services/billing";
import { initRealtime } from "./realtime";

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
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api", apiLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/boards", boardsRouter);
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
    // eslint-disable-next-line no-console
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  httpServer.listen(env.PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${env.PORT}`);
  });
}

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});
