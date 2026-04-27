-- AlterTable
ALTER TABLE "RefreshToken" ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '1 day';
