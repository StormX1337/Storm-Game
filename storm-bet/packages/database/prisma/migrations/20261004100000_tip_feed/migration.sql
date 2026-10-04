-- CreateTable
CREATE TABLE "shared_bets" (
    "id" UUID NOT NULL,
    "bet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_bets_bet_id_key" ON "shared_bets"("bet_id");

-- CreateIndex
CREATE INDEX "shared_bets_created_at_idx" ON "shared_bets"("created_at");

-- AddForeignKey
ALTER TABLE "shared_bets" ADD CONSTRAINT "shared_bets_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_bets" ADD CONSTRAINT "shared_bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

