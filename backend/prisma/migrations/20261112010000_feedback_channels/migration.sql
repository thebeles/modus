BEGIN;

-- AlterTable
ALTER TABLE "Appeal" ALTER COLUMN "authorId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AnonymousAccess" (
    "appealId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,

    CONSTRAINT "AnonymousAccess_pkey" PRIMARY KEY ("appealId")
);

-- CreateTable
CREATE TABLE "AnonymousMessage" (
    "id" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnonymousMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "isSynthetic" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "improvementId" TEXT,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalVote" (
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ProposalVote_pkey" PRIMARY KEY ("proposalId","userId")
);

-- CreateTable
CREATE TABLE "ProposalComment" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerReview" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "isSynthetic" BOOLEAN NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerReviewAppeal" (
    "reviewId" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,

    CONSTRAINT "CustomerReviewAppeal_pkey" PRIMARY KEY ("reviewId","appealId")
);

-- CreateTable
CREATE TABLE "CustomerReviewImprovement" (
    "reviewId" TEXT NOT NULL,
    "improvementId" TEXT NOT NULL,

    CONSTRAINT "CustomerReviewImprovement_pkey" PRIMARY KEY ("reviewId","improvementId")
);

-- CreateTable
CREATE TABLE "OneCRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "improvementId" TEXT,
    "mode" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneCRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OneCOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestId" TEXT,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OneCOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnonymousAccess_tokenHash_key" ON "AnonymousAccess"("tokenHash");

-- CreateIndex
CREATE INDEX "AnonymousMessage_appealId_createdAt_id_idx" ON "AnonymousMessage"("appealId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_improvementId_key" ON "Proposal"("improvementId");

-- CreateIndex
CREATE INDEX "Proposal_departmentId_isSynthetic_createdAt_idx" ON "Proposal"("departmentId", "isSynthetic", "createdAt");

-- CreateIndex
CREATE INDEX "ProposalComment_proposalId_createdAt_id_idx" ON "ProposalComment"("proposalId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "CustomerReview_departmentId_isSynthetic_category_idx" ON "CustomerReview"("departmentId", "isSynthetic", "category");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerReview_departmentId_isSynthetic_fingerprint_key" ON "CustomerReview"("departmentId", "isSynthetic", "fingerprint");

-- CreateIndex
CREATE INDEX "OneCRequest_userId_mode_createdAt_idx" ON "OneCRequest"("userId", "mode", "createdAt");

-- CreateIndex
CREATE INDEX "OneCRequest_improvementId_idx" ON "OneCRequest"("improvementId");

-- CreateIndex
CREATE UNIQUE INDEX "OneCRequest_userId_key_key" ON "OneCRequest"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OneCRequest_mode_externalId_key" ON "OneCRequest"("mode", "externalId");

-- CreateIndex
CREATE INDEX "OneCOperation_userId_mode_createdAt_idx" ON "OneCOperation"("userId", "mode", "createdAt");

-- AddForeignKey
ALTER TABLE "AnonymousAccess" ADD CONSTRAINT "AnonymousAccess_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnonymousMessage" ADD CONSTRAINT "AnonymousMessage_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "AnonymousAccess"("appealId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVote" ADD CONSTRAINT "ProposalVote_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVote" ADD CONSTRAINT "ProposalVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalComment" ADD CONSTRAINT "ProposalComment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalComment" ADD CONSTRAINT "ProposalComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReview" ADD CONSTRAINT "CustomerReview_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReviewAppeal" ADD CONSTRAINT "CustomerReviewAppeal_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "CustomerReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReviewAppeal" ADD CONSTRAINT "CustomerReviewAppeal_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReviewImprovement" ADD CONSTRAINT "CustomerReviewImprovement_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "CustomerReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerReviewImprovement" ADD CONSTRAINT "CustomerReviewImprovement_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneCRequest" ADD CONSTRAINT "OneCRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneCRequest" ADD CONSTRAINT "OneCRequest_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneCOperation" ADD CONSTRAINT "OneCOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "CustomerReview_similarity_idx" ON "CustomerReview"
USING gin ((title || ' ' || left(body, 1000)) gin_trgm_ops);

ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_anonymous_scope_check"
CHECK ("authorId" IS NOT NULL OR (visibility = 'SPECIAL' AND "departmentId" IS NULL));

ALTER TABLE "AnonymousMessage" ADD CONSTRAINT "AnonymousMessage_side_check" CHECK (side IN ('AUTHOR', 'STAFF'));

ALTER TABLE "OneCRequest" ADD CONSTRAINT "OneCRequest_status_check"
CHECK (quantity > 0 AND mode IN ('http', 'simulator') AND status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'REJECTED')
  AND ((status = 'PENDING') = ("externalId" IS NULL)));

COMMIT;
