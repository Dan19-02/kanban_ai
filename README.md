# Meeting to Kanban AI: Backend

The API, real-time, persistence, AI analysis, and billing for **Meeting to Kanban
AI**. Pairs with the separate frontend repo (`meeting-to-kanban-ai`), which is
deployed as its own static site.

## Tech stack

| Layer    | Choice                                            |
| -------- | ------------------------------------------------- |
| Runtime  | Node.js 20+, Express, Socket.IO                   |
| Database | PostgreSQL via Prisma ORM                         |
| Auth     | bcrypt + JWT (HS256) in an httpOnly cookie        |
| AI       | NVIDIA-hosted models (`/v1/chat/completions`)     |
| Payments | Stripe subscriptions (Checkout + Billing Portal)  |

## Architecture

```
server/
  index.ts              # app assembly: helmet, CORS, routes, realtime
  env.ts                # validated environment config (fails fast)
  prisma.ts             # shared Prisma client
  auth/                 # password hashing, JWT, cookies, auth middleware
  lib/                  # http helpers, zod parse, CORS allow-list
  middleware/           # rate limiters
  routes/               # /api/auth, /api/boards, /api/billing
  services/             # board access, AI analysis, plans, Stripe billing
  realtime/             # authenticated Socket.IO + board broadcasts
  validation.ts         # zod request schemas
prisma/
  schema.prisma         # data model
  migrations/           # SQL migrations
```

Mutations go through authenticated, validated, role-checked REST endpoints; the
server then broadcasts updated board state to everyone in that board's room.

## Local development

```bash
npm install
cp .env.example .env       # set JWT_SECRET; optionally NVIDIA_API_KEY

docker compose up -d       # local Postgres (matches the default DATABASE_URL)
npm run db:deploy          # apply migrations
npm run dev                # API on http://localhost:3000
```

Then start the frontend (`npm run dev` in the frontend repo, port 5173). The
frontend dev server proxies `/api` and `/socket.io` here, so cookies stay
first-party locally.

## Environment variables

| Variable                | Required | Description                                                |
| ----------------------- | -------- | ---------------------------------------------------------- |
| `DATABASE_URL`          | yes      | PostgreSQL connection string.                              |
| `JWT_SECRET`            | yes      | ≥ 32 random chars. Signs session JWTs.                     |
| `APP_URL`               | prod     | Frontend origin. Locks down CORS + builds share links.     |
| `NVIDIA_API_KEY`        | no       | Enables AI analysis. Without it, analyze returns an error. |
| `NVIDIA_MODELS`         | no       | Comma-separated model ids to try, in order. Defaults to the list in `server/services/ai.ts`. |
| `COOKIE_DOMAIN`         | no       | Shared parent domain for first-party cross-subdomain auth. |
| `NODE_ENV` / `PORT`     | no       | Default `development` / `3000` (Render injects `PORT`).    |
| `STRIPE_*`              | no       | Enables paid plans; free tier works without them.          |

## Deploy on Render (Web Service + Postgres)

This repo ships a `render.yaml` blueprint that provisions a managed Postgres,
generates `JWT_SECRET`, runs migrations on each deploy, and starts the API.

1. Render Dashboard → **New → Blueprint** → select this repo.
2. Set **`APP_URL`** to the frontend Static Site URL, and `NVIDIA_API_KEY` /
   `STRIPE_*` as needed.
3. Deploy. `GET /api/health` says the process is up and which commit it runs.
   `GET /api/health/db` says whether it can reach the database.

> Using an existing database (Aiven/Neon/Supabase)? Delete the `databases:` block
> in `render.yaml` and set `DATABASE_URL` directly. Fresh databases get all
> migrations via `prisma migrate deploy`; a database that already has a different
> migration history must be reset or baselined first.

> **The free Render Postgres expires 30 days after it is created.** Once it is
> gone, sign-in answers 503 and every deploy fails at the migration step, because
> the build runs `prisma migrate deploy`. For a demo that has to stay up, set
> `DATABASE_URL` to a free database that does not expire (Neon, for example).

## Security notes

- Passwords: bcrypt (cost 12); login is constant-time to prevent user enumeration.
- Sessions: JWTs (HS256, algorithm-pinned) in `httpOnly` cookies, `SameSite=None;
  Secure` in production (cross-site) and `Lax` in development. Each token carries
  the user's token version; signing out raises it, which ends every session for
  that account, so a copied token stops working.
- CORS: strict, credentialed allow-list (`APP_URL` + dev origins only).
- Authorization: every board action is role-checked (owner / editor / viewer);
  the Socket.IO handshake is authenticated from the same cookie.
- Helmet security headers (CSP, HSTS, …); rate limiting on auth and AI endpoints.
- All request bodies validated with zod; Stripe webhooks signature-verified.
- AI replies are never trusted as written: the JSON is extracted from any
  reasoning or code fence around it, then every field is checked and normalised
  before it is stored.
- A transcription is taken from the allowance in one conditional update before
  the AI is called, and handed back if the analysis fails, so parallel requests
  cannot overspend a plan.
- A database outage answers 503 with a clear message instead of stopping the
  server, and reads recover on their own when the database returns.
