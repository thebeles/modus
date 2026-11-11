-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'HANDLER', 'MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('NORMAL_INTERNAL', 'RESTRICTED', 'SPECIAL');

-- CreateEnum
CREATE TYPE "AppealType" AS ENUM ('PROBLEM', 'PROPOSAL', 'POSITIVE_FEEDBACK');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('NEW', 'REVIEW', 'WAITING_AUTHOR', 'IN_PROGRESS', 'CLOSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "Origin" AS ENUM ('ORIGINAL_DOCX', 'DEMO_SYNTHETIC', 'USER_CREATED');

-- CreateEnum
CREATE TYPE "Resolution" AS ENUM ('RESOLVED', 'ACCEPTED_FOR_IMPROVEMENT', 'EXPLANATION_PROVIDED', 'REJECTED', 'ALREADY_ADDRESSED', 'LINKED_TO_EXISTING_CASE', 'TRANSFERRED', 'POSITIVE_FEEDBACK_RECORDED', 'INSUFFICIENT_INFO');

-- CreateEnum
CREATE TYPE "ProblemStatus" AS ENUM ('CANDIDATE', 'INVESTIGATING', 'CONFIRMED', 'DISPROVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ImprovementStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'DEFERRED', 'REJECTED', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFYING', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('VERIFIED', 'PARTIAL', 'NOT_ACHIEVED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "Relation" AS ENUM ('SIMILAR_TOPIC', 'POSSIBLE_DUPLICATE', 'CONFIRMED_SAME_ISSUE', 'ADDRESSED_BY_IMPROVEMENT', 'RELATED_CONTEXT');

-- CreateEnum
CREATE TYPE "LinkState" AS ENUM ('SUGGESTED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublicationState" AS ENUM ('DRAFT', 'APPROVED', 'PUBLISHED', 'RETRACTED');

-- CreateEnum
CREATE TYPE "FeedbackChoice" AS ENUM ('YES', 'PARTLY', 'NO', 'CANNOT_ASSESS');

-- CreateTable
CREATE TABLE "OrganizationUnit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "OrganizationUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "departmentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProcess" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "BusinessProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkQueue" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL,
    "fallback" BOOLEAN NOT NULL DEFAULT false,
    "coordinatorId" TEXT NOT NULL,

    CONSTRAINT "WorkQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueMember" (
    "userId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,

    CONSTRAINT "QueueMember_pkey" PRIMARY KEY ("userId","queueId")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "departmentId" TEXT,
    "processId" TEXT,
    "queueId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaPolicy" (
    "id" TEXT NOT NULL,
    "priority" "Priority" NOT NULL,
    "firstResponseHours" INTEGER NOT NULL,
    "nextActionHours" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "departmentId" TEXT,
    "assigneeId" TEXT,
    "queueId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionOriginal" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "proposedSolution" TEXT,
    "categoryId" TEXT,
    "processId" TEXT,
    "type" "AppealType" NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'NEW',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "visibility" "Visibility" NOT NULL DEFAULT 'NORMAL_INTERNAL',
    "resolutionType" "Resolution",
    "resolutionText" TEXT,
    "resolutionBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "waitingSince" TIMESTAMP(3),
    "resumeState" "AppealStatus",
    "firstHumanResponseAt" TIMESTAMP(3),
    "firstResponseDueAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "slaVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "seedOrigin" "Origin" NOT NULL DEFAULT 'USER_CREATED',
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "sourceId" TEXT,
    "sourceSnapshot" JSONB,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'COMMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "appealId" TEXT,
    "uploaderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "symptoms" TEXT NOT NULL,
    "hypothesis" TEXT,
    "conclusion" TEXT,
    "status" "ProblemStatus" NOT NULL DEFAULT 'CANDIDATE',
    "visibility" "Visibility" NOT NULL DEFAULT 'NORMAL_INTERNAL',
    "departmentId" TEXT,
    "ownerId" TEXT NOT NULL,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemAppeal" (
    "problemId" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,

    CONSTRAINT "ProblemAppeal_pkey" PRIMARY KEY ("problemId","appealId")
);

-- CreateTable
CREATE TABLE "ProblemFinding" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppealLink" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" "Relation" NOT NULL,
    "state" "LinkState" NOT NULL DEFAULT 'SUGGESTED',
    "explanation" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL DEFAULT 'USER',
    "confirmedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppealLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Improvement" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "risks" TEXT,
    "scope" TEXT NOT NULL,
    "status" "ImprovementStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'NORMAL_INTERNAL',
    "departmentId" TEXT,
    "processId" TEXT,
    "ownerId" TEXT NOT NULL,
    "problemId" TEXT,
    "implementationNotes" TEXT,
    "implementedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Improvement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImprovementAppeal" (
    "improvementId" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,

    CONSTRAINT "ImprovementAppeal_pkey" PRIMARY KEY ("improvementId","appealId")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "improvementId" TEXT NOT NULL,
    "status" "ImprovementStatus" NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "improvementId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "status" "ActionStatus" NOT NULL DEFAULT 'TODO',
    "result" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementPlan" (
    "improvementId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "metricName" TEXT,
    "unit" TEXT,
    "direction" TEXT,
    "targetValue" DOUBLE PRECISION,
    "protocol" TEXT,

    CONSTRAINT "MeasurementPlan_pkey" PRIMARY KEY ("improvementId")
);

-- CreateTable
CREATE TABLE "Measurement" (
    "id" TEXT NOT NULL,
    "improvementId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "sampleSize" INTEGER,
    "source" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "improvementId" TEXT NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "summary" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "verifierId" TEXT NOT NULL,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("improvementId")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "improvementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "choice" "FeedbackChoice",
    "comment" TEXT,
    "submittedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "improvementId" TEXT NOT NULL,
    "state" "PublicationState" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "audienceId" TEXT,
    "authorId" TEXT NOT NULL,
    "approvedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "authorVisible" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxJob" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "href" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),

    CONSTRAINT "OutboxJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "userId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("userId","route","key")
);

-- CreateTable
CREATE TABLE "RateBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "inputLength" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationUnit_name_key" ON "OrganizationUnit"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProcess_name_key" ON "BusinessProcess"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkQueue_name_key" ON "WorkQueue"("name");

-- CreateIndex
CREATE INDEX "WorkQueue_visibility_fallback_idx" ON "WorkQueue"("visibility", "fallback");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingRule_name_key" ON "RoutingRule"("name");

-- CreateIndex
CREATE INDEX "RoutingRule_categoryId_rank_idx" ON "RoutingRule"("categoryId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "SlaPolicy_priority_key" ON "SlaPolicy"("priority");

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_number_key" ON "Appeal"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_sourceId_key" ON "Appeal"("sourceId");

-- CreateIndex
CREATE INDEX "Appeal_createdAt_idx" ON "Appeal"("createdAt");

-- CreateIndex
CREATE INDEX "Appeal_status_dueAt_idx" ON "Appeal"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Appeal_authorId_idx" ON "Appeal"("authorId");

-- CreateIndex
CREATE INDEX "Appeal_assigneeId_idx" ON "Appeal"("assigneeId");

-- CreateIndex
CREATE INDEX "Appeal_queueId_idx" ON "Appeal"("queueId");

-- CreateIndex
CREATE INDEX "Appeal_departmentId_idx" ON "Appeal"("departmentId");

-- CreateIndex
CREATE INDEX "Appeal_categoryId_idx" ON "Appeal"("categoryId");

-- CreateIndex
CREATE INDEX "Appeal_priority_idx" ON "Appeal"("priority");

-- CreateIndex
CREATE INDEX "Appeal_processId_idx" ON "Appeal"("processId");

-- CreateIndex
CREATE INDEX "Comment_appealId_createdAt_idx" ON "Comment"("appealId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_appealId_idx" ON "Attachment"("appealId");

-- CreateIndex
CREATE INDEX "Attachment_uploaderId_idx" ON "Attachment"("uploaderId");

-- CreateIndex
CREATE INDEX "ReviewRequest_appealId_idx" ON "ReviewRequest"("appealId");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_number_key" ON "Problem"("number");

-- CreateIndex
CREATE INDEX "Problem_departmentId_status_idx" ON "Problem"("departmentId", "status");

-- CreateIndex
CREATE INDEX "ProblemAppeal_appealId_idx" ON "ProblemAppeal"("appealId");

-- CreateIndex
CREATE INDEX "ProblemFinding_problemId_idx" ON "ProblemFinding"("problemId");

-- CreateIndex
CREATE INDEX "AppealLink_toId_idx" ON "AppealLink"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "AppealLink_fromId_toId_relation_key" ON "AppealLink"("fromId", "toId", "relation");

-- CreateIndex
CREATE UNIQUE INDEX "Improvement_number_key" ON "Improvement"("number");

-- CreateIndex
CREATE INDEX "Improvement_departmentId_status_idx" ON "Improvement"("departmentId", "status");

-- CreateIndex
CREATE INDEX "Improvement_ownerId_idx" ON "Improvement"("ownerId");

-- CreateIndex
CREATE INDEX "Improvement_problemId_idx" ON "Improvement"("problemId");

-- CreateIndex
CREATE INDEX "ImprovementAppeal_appealId_idx" ON "ImprovementAppeal"("appealId");

-- CreateIndex
CREATE INDEX "ApprovalDecision_improvementId_idx" ON "ApprovalDecision"("improvementId");

-- CreateIndex
CREATE INDEX "ActionItem_improvementId_idx" ON "ActionItem"("improvementId");

-- CreateIndex
CREATE INDEX "ActionItem_ownerId_idx" ON "ActionItem"("ownerId");

-- CreateIndex
CREATE INDEX "Measurement_improvementId_phase_idx" ON "Measurement"("improvementId", "phase");

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_improvementId_userId_key" ON "Feedback"("improvementId", "userId");

-- CreateIndex
CREATE INDEX "Publication_state_audienceId_idx" ON "Publication"("state", "audienceId");

-- CreateIndex
CREATE INDEX "AuditEvent_entity_entityId_createdAt_idx" ON "AuditEvent"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxJob_key_key" ON "OutboxJob"("key");

-- CreateIndex
CREATE INDEX "OutboxJob_deliveredAt_deadAt_availableAt_idx" ON "OutboxJob"("deliveredAt", "deadAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_key_key" ON "Notification"("key");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "RateBucket_expiresAt_idx" ON "RateBucket"("expiresAt");

-- CreateIndex
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationUnit" ADD CONSTRAINT "OrganizationUnit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkQueue" ADD CONSTRAINT "WorkQueue_coordinatorId_fkey" FOREIGN KEY ("coordinatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueMember" ADD CONSTRAINT "QueueMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueMember" ADD CONSTRAINT "QueueMember_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "WorkQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_processId_fkey" FOREIGN KEY ("processId") REFERENCES "BusinessProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "WorkQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "WorkQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_processId_fkey" FOREIGN KEY ("processId") REFERENCES "BusinessProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemAppeal" ADD CONSTRAINT "ProblemAppeal_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemAppeal" ADD CONSTRAINT "ProblemAppeal_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemFinding" ADD CONSTRAINT "ProblemFinding_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLink" ADD CONSTRAINT "AppealLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLink" ADD CONSTRAINT "AppealLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Improvement" ADD CONSTRAINT "Improvement_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Improvement" ADD CONSTRAINT "Improvement_processId_fkey" FOREIGN KEY ("processId") REFERENCES "BusinessProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Improvement" ADD CONSTRAINT "Improvement_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Improvement" ADD CONSTRAINT "Improvement_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementAppeal" ADD CONSTRAINT "ImprovementAppeal_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementAppeal" ADD CONSTRAINT "ImprovementAppeal_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeasurementPlan" ADD CONSTRAINT "MeasurementPlan_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "MeasurementPlan"("improvementId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_improvementId_fkey" FOREIGN KEY ("improvementId") REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "OrganizationUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxJob" ADD CONSTRAINT "OutboxJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WorkQueue_one_fallback_per_visibility" ON "WorkQueue" ("visibility") WHERE "fallback";
ALTER TABLE "AppealLink" ADD CONSTRAINT "AppealLink_ordered_pair" CHECK ("fromId" < "toId");
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_closed_result" CHECK ("status" <> 'CLOSED' OR ("resolutionText" IS NOT NULL AND "resolutionType" IS NOT NULL AND "closedAt" IS NOT NULL));
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_waiting_state" CHECK ("status" <> 'WAITING_AUTHOR' OR ("waitingSince" IS NOT NULL AND "resumeState" IN ('REVIEW', 'IN_PROGRESS')));
ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_valid_period" CHECK ("periodEnd" > "periodStart");
CREATE UNIQUE INDEX "ReviewRequest_one_pending" ON "ReviewRequest" ("appealId") WHERE "decidedAt" IS NULL;
