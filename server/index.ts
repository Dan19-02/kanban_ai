import "dotenv/config"; // Load .env before anything reads process.env.
import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import http from "http";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import { env, isProduction } from "./env";
import { ApiError } from "./lib/http";
import { apiLimiter } from "./middleware/rateLimit";
import { authRouter } from "./routes/auth";
import { boardsRouter } from "./routes/boards";
import { billingRouter } from "./routes/billing";
import { constructWebhookEvent, handleWebhookEvent } from "./services/billing";
import { initRealtime } from "./realtime";

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // Behind a reverse proxy (Cloud Run, Nginx, etc.) trust X-Forwarded-* so
  // secure cookies, client IPs (rate limiting) and protocol detection work.
  if (isProduction) app.set("trust proxy", 1);

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
  initRealtime(httpServer, env.APP_URL ?? true);

  // --- Frontend (static files in production, API-only in development) ---
  if (isProduction) {
    const distPath = path.join(process.cwd(), "dist/public");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    // eslint-disable-next-line no-console
    console.log("Running in API-only mode (no frontend served)");
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
