import { Prisma, PrismaClient } from "@prisma/client";
import { isProduction } from "./env";

// Operations that only read, so repeating one cannot apply a change twice.
const READS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "$queryRaw",
]);

// How many pooled connections one read may work through before giving up.
const MAX_READ_TRIES = 10;

/**
 * P1017, "Server has closed the connection": a pooled connection went stale
 * because the database restarted, or a serverless one went to sleep and dropped
 * it. The connection is thrown away when this happens, so the next try gets
 * another one.
 */
const isStaleConnection = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P1017";

function createClient() {
  return new PrismaClient({
    log: isProduction ? ["error"] : ["error", "warn"],
  }).$extends({
    name: "retry-reads-on-stale-connection",
    query: {
      // Without this, the first few requests after the database comes back each
      // fail on a dead connection. A read is repeated until it reaches a live
      // one. A write is never repeated: it may already have been applied.
      async $allOperations({ operation, args, query }) {
        const tries = READS.has(operation) ? MAX_READ_TRIES : 1;
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await query(args);
          } catch (err) {
            if (attempt >= tries || !isStaleConnection(err)) throw err;
          }
        }
      },
    },
  });
}

/**
 * Single shared PrismaClient instance.
 *
 * In development the module can be re-evaluated on reload, so we cache the
 * client on `globalThis` to avoid exhausting the database connection pool.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? createClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
