import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * The process fails fast at boot if a required variable is missing or invalid,
 * so we never start the server in a half-configured state.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),

  // Postgres connection string, e.g. postgresql://user:pass@localhost:5432/db
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (see .env.example / docker-compose.yml)"),

  // Secret used to sign auth JWTs. Must be long and random in production.
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48"),

  // NVIDIA API key for MiniMax M3. Optional at boot — the analyze endpoint
  // returns a clear error if it is missing, so the rest of the app still runs
  // without it.
  NVIDIA_API_KEY: z.string().optional(),

  // Public URL of the deployed app. Used for CORS allow-listing and building
  // share links. Optional in development (defaults to same-origin).
  APP_URL: z.string().url().optional(),

  // --- Stripe billing (all optional; billing endpoints return a clear error
  // when the secret key is absent, so the app runs fully without payments) ---
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Price IDs created in the Stripe dashboard for each paid tier.
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_UNLIMITED: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(
    `\n❌ Invalid environment configuration:\n${issues}\n\n` +
      `Copy .env.example to .env and fill in the values.\n`,
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
