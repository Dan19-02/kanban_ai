-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT 'indigo',
    "ownerId" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");

-- AlterTable
ALTER TABLE "Board" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "Board_projectId_idx" ON "Board"("projectId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Board" ADD CONSTRAINT "Board_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: give every owner that has unfiled boards a default "General" project
-- and move their existing boards into it, so prior data fits the new hierarchy.
INSERT INTO "Project" ("id", "name", "color", "ownerId", "archived", "createdAt", "updatedAt")
SELECT
    'proj_' || replace(gen_random_uuid()::text, '-', ''),
    'General',
    'indigo',
    o."ownerId",
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "ownerId" FROM "Board" WHERE "projectId" IS NULL) o;

UPDATE "Board" bd
SET "projectId" = p."id"
FROM "Project" p
WHERE p."ownerId" = bd."ownerId"
  AND p."name" = 'General'
  AND bd."projectId" IS NULL;
