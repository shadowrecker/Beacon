-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'ROADMAP_IMPORT';
ALTER TYPE "JobKind" ADD VALUE 'ANALYTICS_IMPORT';

-- AlterEnum
ALTER TYPE "RoadmapSource" ADD VALUE 'CSV';
ALTER TYPE "RoadmapSource" ADD VALUE 'PRODUCTBOARD';



DROP INDEX "outcome_trackings_recommendationId_idx";

-- AlterTable
ALTER TABLE "syntheses" ADD COLUMN     "causationDepth" INTEGER NOT NULL DEFAULT 0;

-- One outcome record per recommendation: keep the oldest if duplicates exist.
DELETE FROM "outcome_trackings" a
USING "outcome_trackings" b
WHERE a."recommendationId" = b."recommendationId"
  AND (a."createdAt", a.id) > (b."createdAt", b.id);

-- CreateIndex
CREATE UNIQUE INDEX "outcome_trackings_recommendationId_key" ON "outcome_trackings"("recommendationId");
