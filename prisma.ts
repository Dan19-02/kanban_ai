import { PrismaClient } from "@prisma/client";
import { isProduction } from "./env";

/**
 * Single shared PrismaClient instance.
 *
 * In development the module can be re-evaluated on reload, so we cache the
 * client on `globalThis` to avoid exhausting the database connection pool.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ["error"] : ["error", "warn"],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
