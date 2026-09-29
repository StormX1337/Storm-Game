-- CreateEnum
CREATE TYPE "CasinoGameType" AS ENUM ('SLOT', 'ROULETTE', 'BLACKJACK', 'BACCARAT');

-- CreateEnum
CREATE TYPE "CasinoGameStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CasinoSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CasinoRoundStatus" AS ENUM ('OPEN', 'SETTLED', 'REFUNDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'CASINO_BET';
ALTER TYPE "TransactionType" ADD VALUE 'CASINO_WIN';
ALTER TYPE "TransactionType" ADD VALUE 'CASINO_REFUND';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "casino_round_id" UUID;

-- CreateTable
CREATE TABLE "casino_providers" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casino_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casino_categories" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casino_categories_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "casino_games" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CasinoGameType" NOT NULL,
    "categories" TEXT[],
    "description" TEXT NOT NULL,
    "status" "CasinoGameStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "is_new" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "min_stake" BIGINT NOT NULL,
    "max_stake" BIGINT NOT NULL,
    "rtp" DECIMAL(5,2) NOT NULL,
    "theme" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casino_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casino_favorites" (
    "user_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "casino_favorites_pkey" PRIMARY KEY ("user_id","game_id")
);

-- CreateTable
CREATE TABLE "casino_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "status" "CasinoSessionStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "closed_reason" TEXT,

    CONSTRAINT "casino_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casino_rounds" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "stake" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL DEFAULT 0,
    "status" "CasinoRoundStatus" NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "casino_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "casino_providers_key_key" ON "casino_providers"("key");

-- CreateIndex
CREATE UNIQUE INDEX "casino_games_slug_key" ON "casino_games"("slug");

-- CreateIndex
CREATE INDEX "casino_games_status_sort_order_idx" ON "casino_games"("status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "casino_games_provider_id_external_id_key" ON "casino_games"("provider_id", "external_id");

-- CreateIndex
CREATE INDEX "casino_sessions_user_id_status_idx" ON "casino_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "casino_sessions_status_last_activity_at_idx" ON "casino_sessions"("status", "last_activity_at");

-- CreateIndex
CREATE INDEX "casino_rounds_user_id_created_at_idx" ON "casino_rounds"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "casino_rounds_game_id_created_at_idx" ON "casino_rounds"("game_id", "created_at");

-- CreateIndex
CREATE INDEX "casino_rounds_status_created_at_idx" ON "casino_rounds"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "casino_rounds_user_id_idempotency_key_key" ON "casino_rounds"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_casino_round_id_idx" ON "transactions"("casino_round_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_casino_round_id_fkey" FOREIGN KEY ("casino_round_id") REFERENCES "casino_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_games" ADD CONSTRAINT "casino_games_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "casino_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_favorites" ADD CONSTRAINT "casino_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_favorites" ADD CONSTRAINT "casino_favorites_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "casino_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_sessions" ADD CONSTRAINT "casino_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_sessions" ADD CONSTRAINT "casino_sessions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "casino_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_rounds" ADD CONSTRAINT "casino_rounds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_rounds" ADD CONSTRAINT "casino_rounds_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "casino_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casino_rounds" ADD CONSTRAINT "casino_rounds_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "casino_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
