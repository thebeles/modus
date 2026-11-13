ALTER TABLE "Appeal" ADD COLUMN "sharedTitle" TEXT;

CREATE TABLE "AppealSubscription" (
    "appealId" TEXT NOT NULL REFERENCES "Appeal"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("appealId", "userId")
);

CREATE INDEX "AppealSubscription_userId_idx" ON "AppealSubscription"("userId");
CREATE INDEX "Appeal_shared_title_search_idx" ON "Appeal" USING GIN ("sharedTitle" gin_trgm_ops);
