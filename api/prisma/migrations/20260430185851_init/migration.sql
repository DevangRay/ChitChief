/*
  Warnings:

  - A unique constraint covering the columns `[date,venue]` on the table `Event` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "RefreshToken" ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '1 day';

-- CreateIndex
CREATE UNIQUE INDEX "Event_date_venue_key" ON "Event"("date", "venue");
