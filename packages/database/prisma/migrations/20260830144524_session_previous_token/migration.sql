-- Track the token a session had before its last rotation, so replaying an
-- old refresh token can be detected and the whole session family revoked.
ALTER TABLE "sessions" ADD COLUMN "previousTokenHash" TEXT;

CREATE UNIQUE INDEX "sessions_previousTokenHash_key" ON "sessions"("previousTokenHash");
