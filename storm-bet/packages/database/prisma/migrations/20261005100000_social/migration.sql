-- AlterTable
ALTER TABLE "users" ADD COLUMN     "leaderboard_opt_in" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "feed_likes" (
    "shared_bet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_likes_pkey" PRIMARY KEY ("shared_bet_id","user_id")
);

-- CreateTable
CREATE TABLE "follows" (
    "follower_id" UUID NOT NULL,
    "followee_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id","followee_id")
);

-- CreateTable
CREATE TABLE "saved_slips" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "selection_ids" UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_slips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feed_likes_user_id_idx" ON "feed_likes"("user_id");

-- CreateIndex
CREATE INDEX "follows_followee_id_idx" ON "follows"("followee_id");

-- CreateIndex
CREATE INDEX "saved_slips_user_id_created_at_idx" ON "saved_slips"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "bets_settled_at_idx" ON "bets"("settled_at");

-- CreateIndex
CREATE INDEX "shared_bets_user_id_created_at_idx" ON "shared_bets"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "feed_likes" ADD CONSTRAINT "feed_likes_shared_bet_id_fkey" FOREIGN KEY ("shared_bet_id") REFERENCES "shared_bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_likes" ADD CONSTRAINT "feed_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_slips" ADD CONSTRAINT "saved_slips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Nobody follows themselves.
ALTER TABLE "follows" ADD CONSTRAINT "follows_not_self" CHECK ("follower_id" <> "followee_id");
