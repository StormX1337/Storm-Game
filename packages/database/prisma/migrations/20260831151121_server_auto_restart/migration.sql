-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "autoRestart" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "restartAttempts" INTEGER NOT NULL DEFAULT 0;
