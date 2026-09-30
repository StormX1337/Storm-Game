-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "boost_id" UUID;

-- CreateTable
CREATE TABLE "odds_boosts" (
    "id" UUID NOT NULL,
    "selection_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "uplift_pct" INTEGER NOT NULL,
    "max_stake" BIGINT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_boosts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "odds_boosts_ends_at_idx" ON "odds_boosts"("ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "bets_user_id_boost_id_key" ON "bets"("user_id", "boost_id");

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_boost_id_fkey" FOREIGN KEY ("boost_id") REFERENCES "odds_boosts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds_boosts" ADD CONSTRAINT "odds_boosts_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Guards ─────────────────────────────────────────────────────────────────
ALTER TABLE "odds_boosts"
  ADD CONSTRAINT "odds_boosts_uplift_valid" CHECK ("uplift_pct" BETWEEN 1 AND 100),
  ADD CONSTRAINT "odds_boosts_max_stake_positive" CHECK ("max_stake" > 0),
  ADD CONSTRAINT "odds_boosts_window_valid" CHECK ("ends_at" > "starts_at");
