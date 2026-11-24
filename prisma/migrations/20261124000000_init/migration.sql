-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "DocumentSource" AS ENUM ('UPLOAD', 'URL', 'INTEGRATION', 'VOICE', 'QUICK_CAPTURE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('TRANSCRIPT', 'SUPPORT_TICKET', 'NOTE', 'CALL_RECORDING', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SynthesisType" AS ENUM ('THEMES', 'PAIN_POINTS', 'FEATURE_REQUESTS', 'FULL');

-- CreateEnum
CREATE TYPE "SynthesisStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED');

-- CreateEnum
CREATE TYPE "RecommendationImpact" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('DRAFT', 'ACCEPTED', 'REJECTED', 'IMPLEMENTED');

-- CreateEnum
CREATE TYPE "OrgMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrgPlan" AS ENUM ('FREE', 'TEAM', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('INTERCOM', 'ZENDESK', 'GONG', 'SLACK', 'HUBSPOT', 'AMPLITUDE', 'MIXPANEL', 'SALESFORCE', 'LINEAR', 'JIRA', 'NOTION', 'PRODUCTBOARD');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CompetitorUpdateType" AS ENUM ('CHANGELOG', 'REVIEW', 'PRESS', 'PRICING', 'FEATURE');

-- CreateEnum
CREATE TYPE "RoadmapSource" AS ENUM ('MANUAL', 'LINEAR', 'JIRA', 'NOTION');

-- CreateEnum
CREATE TYPE "RoadmapItemStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RoadmapItemPriority" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "AnalyticsSource" AS ENUM ('AMPLITUDE', 'MIXPANEL', 'POSTHOG', 'CSV');

-- CreateEnum
CREATE TYPE "CommentTargetType" AS ENUM ('THEME', 'RECOMMENDATION', 'SYNTHESIS', 'DOCUMENT', 'DECISION');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('COMMENT_MENTION', 'COMMENT_REPLY', 'SYNTHESIS_COMPLETE', 'RECOMMENDATION_GENERATED', 'INTEGRATION_SYNC', 'COMPETITOR_ALERT', 'SENTIMENT_ALERT', 'OUTCOME_UPDATE', 'ORG_INVITE', 'WORKFLOW', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('NOT_SHIPPED', 'SHIPPED', 'MEASURING', 'MEASURED');

-- CreateEnum
CREATE TYPE "CoachInsightType" AS ENUM ('FRAMEWORK_SUGGESTION', 'PROCESS_IMPROVEMENT', 'BEST_PRACTICE', 'WARNING', 'NUDGE');

-- CreateEnum
CREATE TYPE "CoachInsightPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CoachInsightStatus" AS ENUM ('NEW', 'SEEN', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "WorkflowEvent" AS ENUM ('THEME_DETECTED', 'RECOMMENDATION_GENERATED', 'SYNTHESIS_COMPLETED', 'COMPETITOR_UPDATE', 'GAP_DETECTED', 'CORRELATION_FOUND', 'DOCUMENT_UPLOADED');

-- CreateEnum
CREATE TYPE "WorkflowActionType" AS ENUM ('CREATE_BRIEF', 'NOTIFY_SLACK', 'NOTIFY_EMAIL', 'ASSIGN_USER', 'ADD_TO_ROADMAP', 'EXPORT_TO_LINEAR', 'EXPORT_TO_JIRA', 'ALERT_TEAM', 'RUN_SYNTHESIS');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL_FAILURE', 'FAILED');

-- CreateEnum
CREATE TYPE "PresentationAudience" AS ENUM ('EXECUTIVE', 'ENGINEERING', 'CUSTOMER', 'BOARD', 'SALES', 'INVESTOR');

-- CreateEnum
CREATE TYPE "PresentationType" AS ENUM ('SYNTHESIS_READOUT', 'RECOMMENDATION_PITCH', 'QBR', 'LAUNCH_BRIEF', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PresentationStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketplaceCategory" AS ENUM ('SUPPORT', 'CRM', 'ANALYTICS', 'COMMUNICATION', 'PRODUCT', 'RESEARCH', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('OAUTH2', 'API_KEY', 'BASIC', 'BEARER');

-- CreateEnum
CREATE TYPE "ConnectorPricing" AS ENUM ('FREE', 'PAID', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "ConnectorInstallStatus" AS ENUM ('INSTALLED', 'CONFIGURED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SentimentPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SentimentAlertType" AS ENUM ('TREND_DECLINE', 'SPIKE_NEGATIVE', 'THEME_EMERGING', 'SEGMENT_RISK');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PERSON', 'COMPANY', 'PRODUCT', 'FEATURE', 'CONCEPT', 'PAIN_POINT', 'PERSONA', 'COMPETITOR', 'USE_CASE');

-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('MENTIONS', 'RELATES_TO', 'CAUSES', 'SOLVES', 'COMPETES_WITH', 'USED_BY', 'PART_OF', 'SIMILAR_TO', 'CONFLICTS_WITH');

-- CreateEnum
CREATE TYPE "MergeSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VoiceRecordingStatus" AS ENUM ('RECORDING', 'UPLOADING', 'TRANSCRIBING', 'ANALYZING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "QuickCaptureType" AS ENUM ('VOICE_NOTE', 'QUICK_THOUGHT', 'CALL_HIGHLIGHT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('RECOMMENDATIONS', 'SENTIMENT', 'CORRELATION', 'KNOWLEDGE_EXTRACTION', 'COMPETITIVE_SCAN', 'COACHING', 'HANDOFF_EXPORT', 'WORKFLOW_MANUAL_RUN');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "avatarUrl" TEXT,
    "notificationPrefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "source" "DocumentSource" NOT NULL DEFAULT 'UPLOAD',
    "mimeType" TEXT,
    "storageKey" TEXT,
    "fileSize" INTEGER,
    "sourceUrl" TEXT,
    "processedText" TEXT,
    "metadata" JSONB,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "integrationId" TEXT,
    "externalId" TEXT,
    "createdById" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "processingCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "embeddingModel" TEXT,
    "position" INTEGER NOT NULL,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "tokenCount" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "syntheses" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "SynthesisType" NOT NULL,
    "output" JSONB,
    "modelUsed" TEXT,
    "status" "SynthesisStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "syntheses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "themes" (
    "id" TEXT NOT NULL,
    "synthesisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sentiment" "Sentiment" NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citations" (
    "id" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "synthesisId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "impact" "RecommendationImpact" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'DRAFT',
    "segments" TEXT[],
    "brief" JSONB,
    "briefGeneratedAt" TIMESTAMP(3),
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queries" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "OrgPlan" NOT NULL DEFAULT 'FREE',
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_members" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgMemberRole" NOT NULL DEFAULT 'MEMBER',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_invites" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgMemberRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_activities" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "credentialsEncrypted" TEXT,
    "credentialsKeyVersion" INTEGER,
    "config" JSONB,
    "syncCursor" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_syncs" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "integration_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_profiles" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "description" TEXT,
    "g2Url" TEXT,
    "captureUrl" TEXT,
    "metadata" JSONB,
    "lastScannedAt" TIMESTAMP(3),
    "lastScanError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_updates" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "type" "CompetitorUpdateType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "contentHash" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "sentiment" "Sentiment" NOT NULL DEFAULT 'NEUTRAL',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_alerts" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmaps" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "RoadmapSource" NOT NULL DEFAULT 'MANUAL',
    "importedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roadmaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_items" (
    "id" TEXT NOT NULL,
    "roadmapId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "RoadmapItemStatus" NOT NULL DEFAULT 'PLANNED',
    "priority" "RoadmapItemPriority" NOT NULL DEFAULT 'P2',
    "quarter" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gap_analyses" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "roadmapId" TEXT NOT NULL,
    "synthesisId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "output" JSONB,
    "evidenceDensity" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gap_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_imports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "integrationId" TEXT,
    "source" "AnalyticsSource" NOT NULL,
    "data" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_correlations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "featureName" TEXT NOT NULL,
    "usageMetric" TEXT NOT NULL,
    "correlationScore" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'neutral',
    "insight" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_correlations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetType" "CommentTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcome_trackings" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "status" "OutcomeStatus" NOT NULL DEFAULT 'NOT_SHIPPED',
    "shippedAt" TIMESTAMP(3),
    "metricName" TEXT,
    "baselineValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "targetValue" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outcome_trackings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recommendationId" TEXT,
    "decision" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "evidence" JSONB,
    "evidenceLinks" TEXT[],
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_ai_configs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taxonomy" JSONB,
    "templates" JSONB,
    "industryPreset" TEXT,
    "systemPromptOverride" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_insights" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" "CoachInsightType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" JSONB,
    "priority" "CoachInsightPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "CoachInsightStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "context" JSONB,
    "recommendations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "eventId" TEXT,
    "causationDepth" INTEGER NOT NULL DEFAULT 0,
    "status" "WorkflowRunStatus" NOT NULL,
    "triggerData" JSONB,
    "actionsExecuted" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presentations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "audience" "PresentationAudience" NOT NULL,
    "type" "PresentationType" NOT NULL,
    "status" "PresentationStatus" NOT NULL DEFAULT 'GENERATING',
    "errorMessage" TEXT,
    "slidesData" JSONB,
    "pdfUrl" TEXT,
    "pptxUrl" TEXT,
    "themeColor" TEXT NOT NULL DEFAULT '#3B82F6',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presentations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presentation_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audience" "PresentationAudience" NOT NULL,
    "type" "PresentationType" NOT NULL,
    "structure" JSONB NOT NULL,
    "thumbnailUrl" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "orgId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "presentation_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_connectors" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "longDescription" TEXT,
    "category" "MarketplaceCategory" NOT NULL,
    "provider" TEXT NOT NULL,
    "logoUrl" TEXT,
    "screenshotUrls" TEXT[],
    "authType" "AuthType" NOT NULL,
    "setupGuide" TEXT,
    "capabilities" JSONB NOT NULL,
    "pricing" "ConnectorPricing" NOT NULL,
    "publisherName" TEXT NOT NULL,
    "publisherUrl" TEXT,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "ratingAverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_reviews" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT,
    "helpful" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_review_votes" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_review_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_installs" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "installedBy" TEXT NOT NULL,
    "integrationId" TEXT,
    "configuredAt" TIMESTAMP(3),
    "status" "ConnectorInstallStatus" NOT NULL DEFAULT 'INSTALLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_installs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "customerSegment" TEXT NOT NULL DEFAULT 'all',
    "period" "SentimentPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "volume" INTEGER NOT NULL,
    "positiveCount" INTEGER NOT NULL,
    "neutralCount" INTEGER NOT NULL,
    "negativeCount" INTEGER NOT NULL,
    "topThemes" JSONB,
    "riskLevel" "RiskLevel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "churn_predictions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "segment" TEXT,
    "churnProbability" DOUBLE PRECISION NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "signals" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "predictedChurnDate" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL,
    "methodology" TEXT NOT NULL DEFAULT 'AI_RISK_ASSESSMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "churn_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_alerts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "SentimentAlertType" NOT NULL,
    "severity" "RiskLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dataPoints" JSONB,
    "status" "AlertStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "sentiment_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entities" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "aliases" TEXT[],
    "description" TEXT,
    "embedding" vector(1536),
    "embeddingModel" TEXT,
    "metadata" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mentionCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_merge_suggestions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "status" "MergeSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_merge_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_relations" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL,
    "evidenceDocuments" TEXT[],
    "evidenceChunkIds" TEXT[],
    "evidenceQuotes" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_node_projects" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_node_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_queries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "results" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_recordings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "duration" INTEGER NOT NULL,
    "audioKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "transcriptText" TEXT,
    "transcriptSegments" JSONB,
    "documentId" TEXT,
    "status" "VoiceRecordingStatus" NOT NULL DEFAULT 'RECORDING',
    "errorMessage" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "deviceInfo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_insights" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "keyPoints" JSONB,
    "painPoints" JSONB,
    "actionItems" JSONB,
    "questions" JSONB,
    "sentimentScore" DOUBLE PRECISION NOT NULL,
    "themes" TEXT[],
    "suggestedFollowUps" JSONB,
    "claudeAnalysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quick_captures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" "QuickCaptureType" NOT NULL,
    "content" TEXT NOT NULL,
    "audioUrl" TEXT,
    "durationSec" INTEGER,
    "syncedToProject" BOOLEAN NOT NULL DEFAULT false,
    "recordingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quick_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "rateLimit" INTEGER NOT NULL DEFAULT 600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "requestSize" INTEGER,
    "responseSize" INTEGER,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "lastTriggeredAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdById" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorUserId" TEXT,
    "causationDepth" INTEGER NOT NULL DEFAULT 0,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerkId_key" ON "users"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_userId_idx" ON "projects"("userId");

-- CreateIndex
CREATE INDEX "projects_orgId_idx" ON "projects"("orgId");

-- CreateIndex
CREATE INDEX "projects_createdAt_idx" ON "projects"("createdAt");

-- CreateIndex
CREATE INDEX "documents_projectId_createdAt_idx" ON "documents"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "documents_integrationId_externalId_key" ON "documents"("integrationId", "externalId");

-- CreateIndex
CREATE INDEX "chunks_projectId_idx" ON "chunks"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_documentId_position_key" ON "chunks"("documentId", "position");

-- CreateIndex
CREATE INDEX "syntheses_projectId_idx" ON "syntheses"("projectId");

-- CreateIndex
CREATE INDEX "syntheses_status_idx" ON "syntheses"("status");

-- CreateIndex
CREATE INDEX "syntheses_createdAt_idx" ON "syntheses"("createdAt");

-- CreateIndex
CREATE INDEX "themes_synthesisId_idx" ON "themes"("synthesisId");

-- CreateIndex
CREATE INDEX "citations_themeId_idx" ON "citations"("themeId");

-- CreateIndex
CREATE INDEX "citations_chunkId_idx" ON "citations"("chunkId");

-- CreateIndex
CREATE INDEX "recommendations_projectId_idx" ON "recommendations"("projectId");

-- CreateIndex
CREATE INDEX "recommendations_synthesisId_idx" ON "recommendations"("synthesisId");

-- CreateIndex
CREATE INDEX "recommendations_status_idx" ON "recommendations"("status");

-- CreateIndex
CREATE INDEX "recommendations_createdAt_idx" ON "recommendations"("createdAt");

-- CreateIndex
CREATE INDEX "queries_projectId_idx" ON "queries"("projectId");

-- CreateIndex
CREATE INDEX "queries_userId_idx" ON "queries"("userId");

-- CreateIndex
CREATE INDEX "queries_createdAt_idx" ON "queries"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_slug_idx" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_createdAt_idx" ON "organizations"("createdAt");

-- CreateIndex
CREATE INDEX "org_members_userId_idx" ON "org_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_members_orgId_userId_key" ON "org_members"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_invites_tokenHash_key" ON "org_invites"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "org_invites_orgId_email_key" ON "org_invites"("orgId", "email");

-- CreateIndex
CREATE INDEX "team_activities_orgId_idx" ON "team_activities"("orgId");

-- CreateIndex
CREATE INDEX "team_activities_userId_idx" ON "team_activities"("userId");

-- CreateIndex
CREATE INDEX "team_activities_createdAt_idx" ON "team_activities"("createdAt");

-- CreateIndex
CREATE INDEX "integrations_userId_idx" ON "integrations"("userId");

-- CreateIndex
CREATE INDEX "integrations_status_idx" ON "integrations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_orgId_provider_key" ON "integrations"("orgId", "provider");

-- CreateIndex
CREATE INDEX "integration_syncs_integrationId_startedAt_idx" ON "integration_syncs"("integrationId", "startedAt");

-- CreateIndex
CREATE INDEX "integration_syncs_status_idx" ON "integration_syncs"("status");

-- CreateIndex
CREATE INDEX "competitor_profiles_orgId_idx" ON "competitor_profiles"("orgId");

-- CreateIndex
CREATE INDEX "competitor_profiles_userId_idx" ON "competitor_profiles"("userId");

-- CreateIndex
CREATE INDEX "competitor_updates_competitorId_idx" ON "competitor_updates"("competitorId");

-- CreateIndex
CREATE INDEX "competitor_updates_type_idx" ON "competitor_updates"("type");

-- CreateIndex
CREATE INDEX "competitor_updates_createdAt_idx" ON "competitor_updates"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_updates_competitorId_contentHash_key" ON "competitor_updates"("competitorId", "contentHash");

-- CreateIndex
CREATE INDEX "competitor_alerts_competitorId_idx" ON "competitor_alerts"("competitorId");

-- CreateIndex
CREATE INDEX "competitor_alerts_userId_idx" ON "competitor_alerts"("userId");

-- CreateIndex
CREATE INDEX "competitor_alerts_isRead_idx" ON "competitor_alerts"("isRead");

-- CreateIndex
CREATE INDEX "competitor_alerts_createdAt_idx" ON "competitor_alerts"("createdAt");

-- CreateIndex
CREATE INDEX "roadmaps_projectId_idx" ON "roadmaps"("projectId");

-- CreateIndex
CREATE INDEX "roadmaps_createdAt_idx" ON "roadmaps"("createdAt");

-- CreateIndex
CREATE INDEX "roadmap_items_roadmapId_idx" ON "roadmap_items"("roadmapId");

-- CreateIndex
CREATE INDEX "roadmap_items_status_idx" ON "roadmap_items"("status");

-- CreateIndex
CREATE INDEX "roadmap_items_priority_idx" ON "roadmap_items"("priority");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_items_roadmapId_externalId_key" ON "roadmap_items"("roadmapId", "externalId");

-- CreateIndex
CREATE INDEX "gap_analyses_projectId_idx" ON "gap_analyses"("projectId");

-- CreateIndex
CREATE INDEX "gap_analyses_roadmapId_idx" ON "gap_analyses"("roadmapId");

-- CreateIndex
CREATE INDEX "gap_analyses_createdAt_idx" ON "gap_analyses"("createdAt");

-- CreateIndex
CREATE INDEX "analytics_imports_projectId_idx" ON "analytics_imports"("projectId");

-- CreateIndex
CREATE INDEX "analytics_imports_integrationId_idx" ON "analytics_imports"("integrationId");

-- CreateIndex
CREATE INDEX "analytics_imports_importedAt_idx" ON "analytics_imports"("importedAt");

-- CreateIndex
CREATE INDEX "usage_correlations_projectId_idx" ON "usage_correlations"("projectId");

-- CreateIndex
CREATE INDEX "usage_correlations_themeId_idx" ON "usage_correlations"("themeId");

-- CreateIndex
CREATE INDEX "usage_correlations_createdAt_idx" ON "usage_correlations"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_correlations_projectId_themeId_featureName_usageMetri_key" ON "usage_correlations"("projectId", "themeId", "featureName", "usageMetric");

-- CreateIndex
CREATE INDEX "comments_userId_idx" ON "comments"("userId");

-- CreateIndex
CREATE INDEX "comments_projectId_idx" ON "comments"("projectId");

-- CreateIndex
CREATE INDEX "comments_targetType_targetId_idx" ON "comments"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "outcome_trackings_recommendationId_idx" ON "outcome_trackings"("recommendationId");

-- CreateIndex
CREATE INDEX "outcome_trackings_status_idx" ON "outcome_trackings"("status");

-- CreateIndex
CREATE INDEX "outcome_trackings_createdAt_idx" ON "outcome_trackings"("createdAt");

-- CreateIndex
CREATE INDEX "decision_logs_projectId_idx" ON "decision_logs"("projectId");

-- CreateIndex
CREATE INDEX "decision_logs_userId_idx" ON "decision_logs"("userId");

-- CreateIndex
CREATE INDEX "decision_logs_createdAt_idx" ON "decision_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "custom_ai_configs_orgId_key" ON "custom_ai_configs"("orgId");

-- CreateIndex
CREATE INDEX "coach_insights_userId_idx" ON "coach_insights"("userId");

-- CreateIndex
CREATE INDEX "coach_insights_projectId_idx" ON "coach_insights"("projectId");

-- CreateIndex
CREATE INDEX "coach_insights_status_idx" ON "coach_insights"("status");

-- CreateIndex
CREATE INDEX "coach_insights_createdAt_idx" ON "coach_insights"("createdAt");

-- CreateIndex
CREATE INDEX "coach_sessions_userId_idx" ON "coach_sessions"("userId");

-- CreateIndex
CREATE INDEX "coach_sessions_createdAt_idx" ON "coach_sessions"("createdAt");

-- CreateIndex
CREATE INDEX "workflows_projectId_idx" ON "workflows"("projectId");

-- CreateIndex
CREATE INDEX "workflows_orgId_idx" ON "workflows"("orgId");

-- CreateIndex
CREATE INDEX "workflows_enabled_idx" ON "workflows"("enabled");

-- CreateIndex
CREATE INDEX "workflows_createdAt_idx" ON "workflows"("createdAt");

-- CreateIndex
CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs"("status");

-- CreateIndex
CREATE INDEX "workflow_runs_startedAt_idx" ON "workflow_runs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflowId_eventId_key" ON "workflow_runs"("workflowId", "eventId");

-- CreateIndex
CREATE INDEX "presentations_projectId_idx" ON "presentations"("projectId");

-- CreateIndex
CREATE INDEX "presentations_userId_idx" ON "presentations"("userId");

-- CreateIndex
CREATE INDEX "presentations_status_idx" ON "presentations"("status");

-- CreateIndex
CREATE INDEX "presentations_createdAt_idx" ON "presentations"("createdAt");

-- CreateIndex
CREATE INDEX "presentation_templates_audience_idx" ON "presentation_templates"("audience");

-- CreateIndex
CREATE INDEX "presentation_templates_type_idx" ON "presentation_templates"("type");

-- CreateIndex
CREATE INDEX "presentation_templates_isPublic_idx" ON "presentation_templates"("isPublic");

-- CreateIndex
CREATE INDEX "presentation_templates_createdAt_idx" ON "presentation_templates"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_connectors_slug_key" ON "marketplace_connectors"("slug");

-- CreateIndex
CREATE INDEX "marketplace_connectors_slug_idx" ON "marketplace_connectors"("slug");

-- CreateIndex
CREATE INDEX "marketplace_connectors_category_idx" ON "marketplace_connectors"("category");

-- CreateIndex
CREATE INDEX "marketplace_connectors_isOfficial_idx" ON "marketplace_connectors"("isOfficial");

-- CreateIndex
CREATE INDEX "marketplace_connectors_isVerified_idx" ON "marketplace_connectors"("isVerified");

-- CreateIndex
CREATE INDEX "marketplace_connectors_createdAt_idx" ON "marketplace_connectors"("createdAt");

-- CreateIndex
CREATE INDEX "connector_reviews_connectorId_idx" ON "connector_reviews"("connectorId");

-- CreateIndex
CREATE INDEX "connector_reviews_userId_idx" ON "connector_reviews"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_reviews_connectorId_userId_key" ON "connector_reviews"("connectorId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_review_votes_reviewId_userId_key" ON "connector_review_votes"("reviewId", "userId");

-- CreateIndex
CREATE INDEX "connector_installs_orgId_idx" ON "connector_installs"("orgId");

-- CreateIndex
CREATE INDEX "connector_installs_status_idx" ON "connector_installs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "connector_installs_connectorId_orgId_key" ON "connector_installs"("connectorId", "orgId");

-- CreateIndex
CREATE INDEX "sentiment_snapshots_projectId_periodStart_idx" ON "sentiment_snapshots"("projectId", "periodStart");

-- CreateIndex
CREATE INDEX "sentiment_snapshots_riskLevel_idx" ON "sentiment_snapshots"("riskLevel");

-- CreateIndex
CREATE UNIQUE INDEX "sentiment_snapshots_projectId_period_periodStart_customerSe_key" ON "sentiment_snapshots"("projectId", "period", "periodStart", "customerSegment");

-- CreateIndex
CREATE INDEX "churn_predictions_projectId_idx" ON "churn_predictions"("projectId");

-- CreateIndex
CREATE INDEX "churn_predictions_riskLevel_idx" ON "churn_predictions"("riskLevel");

-- CreateIndex
CREATE INDEX "churn_predictions_churnProbability_idx" ON "churn_predictions"("churnProbability");

-- CreateIndex
CREATE INDEX "churn_predictions_createdAt_idx" ON "churn_predictions"("createdAt");

-- CreateIndex
CREATE INDEX "sentiment_alerts_projectId_idx" ON "sentiment_alerts"("projectId");

-- CreateIndex
CREATE INDEX "sentiment_alerts_type_idx" ON "sentiment_alerts"("type");

-- CreateIndex
CREATE INDEX "sentiment_alerts_status_idx" ON "sentiment_alerts"("status");

-- CreateIndex
CREATE INDEX "sentiment_alerts_createdAt_idx" ON "sentiment_alerts"("createdAt");

-- CreateIndex
CREATE INDEX "knowledge_entities_orgId_type_idx" ON "knowledge_entities"("orgId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entities_orgId_normalizedName_type_key" ON "knowledge_entities"("orgId", "normalizedName", "type");

-- CreateIndex
CREATE INDEX "knowledge_merge_suggestions_orgId_status_idx" ON "knowledge_merge_suggestions"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_merge_suggestions_sourceId_targetId_key" ON "knowledge_merge_suggestions"("sourceId", "targetId");

-- CreateIndex
CREATE INDEX "knowledge_relations_sourceId_idx" ON "knowledge_relations"("sourceId");

-- CreateIndex
CREATE INDEX "knowledge_relations_targetId_idx" ON "knowledge_relations"("targetId");

-- CreateIndex
CREATE INDEX "knowledge_relations_type_idx" ON "knowledge_relations"("type");

-- CreateIndex
CREATE INDEX "knowledge_relations_createdAt_idx" ON "knowledge_relations"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_relations_sourceId_targetId_type_key" ON "knowledge_relations"("sourceId", "targetId", "type");

-- CreateIndex
CREATE INDEX "knowledge_node_projects_projectId_idx" ON "knowledge_node_projects"("projectId");

-- CreateIndex
CREATE INDEX "knowledge_node_projects_entityId_idx" ON "knowledge_node_projects"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_node_projects_entityId_projectId_key" ON "knowledge_node_projects"("entityId", "projectId");

-- CreateIndex
CREATE INDEX "knowledge_queries_orgId_idx" ON "knowledge_queries"("orgId");

-- CreateIndex
CREATE INDEX "knowledge_queries_userId_idx" ON "knowledge_queries"("userId");

-- CreateIndex
CREATE INDEX "knowledge_queries_createdAt_idx" ON "knowledge_queries"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "voice_recordings_documentId_key" ON "voice_recordings"("documentId");

-- CreateIndex
CREATE INDEX "voice_recordings_userId_idx" ON "voice_recordings"("userId");

-- CreateIndex
CREATE INDEX "voice_recordings_projectId_idx" ON "voice_recordings"("projectId");

-- CreateIndex
CREATE INDEX "voice_recordings_status_idx" ON "voice_recordings"("status");

-- CreateIndex
CREATE INDEX "voice_recordings_createdAt_idx" ON "voice_recordings"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "voice_insights_recordingId_key" ON "voice_insights"("recordingId");

-- CreateIndex
CREATE INDEX "voice_insights_recordingId_idx" ON "voice_insights"("recordingId");

-- CreateIndex
CREATE INDEX "voice_insights_createdAt_idx" ON "voice_insights"("createdAt");

-- CreateIndex
CREATE INDEX "quick_captures_userId_idx" ON "quick_captures"("userId");

-- CreateIndex
CREATE INDEX "quick_captures_projectId_idx" ON "quick_captures"("projectId");

-- CreateIndex
CREATE INDEX "quick_captures_type_idx" ON "quick_captures"("type");

-- CreateIndex
CREATE INDEX "quick_captures_createdAt_idx" ON "quick_captures"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_orgId_idx" ON "api_keys"("orgId");

-- CreateIndex
CREATE INDEX "api_keys_createdBy_idx" ON "api_keys"("createdBy");

-- CreateIndex
CREATE INDEX "api_usage_apiKeyId_idx" ON "api_usage"("apiKeyId");

-- CreateIndex
CREATE INDEX "api_usage_timestamp_idx" ON "api_usage"("timestamp");

-- CreateIndex
CREATE INDEX "api_usage_endpoint_idx" ON "api_usage"("endpoint");

-- CreateIndex
CREATE INDEX "webhooks_orgId_idx" ON "webhooks"("orgId");

-- CreateIndex
CREATE INDEX "webhooks_active_idx" ON "webhooks"("active");

-- CreateIndex
CREATE INDEX "webhooks_createdAt_idx" ON "webhooks"("createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_createdAt_idx" ON "webhook_deliveries"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries"("event");

-- CreateIndex
CREATE INDEX "job_runs_projectId_kind_createdAt_idx" ON "job_runs"("projectId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "job_runs_status_updatedAt_idx" ON "job_runs"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "domain_events_orgId_createdAt_idx" ON "domain_events"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "domain_events_type_createdAt_idx" ON "domain_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "token_usage_orgId_createdAt_idx" ON "token_usage"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syntheses" ADD CONSTRAINT "syntheses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "themes" ADD CONSTRAINT "themes_synthesisId_fkey" FOREIGN KEY ("synthesisId") REFERENCES "syntheses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_synthesisId_fkey" FOREIGN KEY ("synthesisId") REFERENCES "syntheses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queries" ADD CONSTRAINT "queries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queries" ADD CONSTRAINT "queries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_activities" ADD CONSTRAINT "team_activities_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_activities" ADD CONSTRAINT "team_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_syncs" ADD CONSTRAINT "integration_syncs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_profiles" ADD CONSTRAINT "competitor_profiles_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_profiles" ADD CONSTRAINT "competitor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_updates" ADD CONSTRAINT "competitor_updates_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "competitor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_alerts" ADD CONSTRAINT "competitor_alerts_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "competitor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_alerts" ADD CONSTRAINT "competitor_alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmaps" ADD CONSTRAINT "roadmaps_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_items" ADD CONSTRAINT "roadmap_items_roadmapId_fkey" FOREIGN KEY ("roadmapId") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gap_analyses" ADD CONSTRAINT "gap_analyses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gap_analyses" ADD CONSTRAINT "gap_analyses_roadmapId_fkey" FOREIGN KEY ("roadmapId") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_imports" ADD CONSTRAINT "analytics_imports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_imports" ADD CONSTRAINT "analytics_imports_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_correlations" ADD CONSTRAINT "usage_correlations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_correlations" ADD CONSTRAINT "usage_correlations_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcome_trackings" ADD CONSTRAINT "outcome_trackings_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_ai_configs" ADD CONSTRAINT "custom_ai_configs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_insights" ADD CONSTRAINT "coach_insights_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_insights" ADD CONSTRAINT "coach_insights_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_sessions" ADD CONSTRAINT "coach_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presentation_templates" ADD CONSTRAINT "presentation_templates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_reviews" ADD CONSTRAINT "connector_reviews_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "marketplace_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_review_votes" ADD CONSTRAINT "connector_review_votes_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "connector_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_installs" ADD CONSTRAINT "connector_installs_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "marketplace_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_installs" ADD CONSTRAINT "connector_installs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_snapshots" ADD CONSTRAINT "sentiment_snapshots_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "churn_predictions" ADD CONSTRAINT "churn_predictions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_alerts" ADD CONSTRAINT "sentiment_alerts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_merge_suggestions" ADD CONSTRAINT "knowledge_merge_suggestions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_merge_suggestions" ADD CONSTRAINT "knowledge_merge_suggestions_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_merge_suggestions" ADD CONSTRAINT "knowledge_merge_suggestions_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "knowledge_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "knowledge_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_node_projects" ADD CONSTRAINT "knowledge_node_projects_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "knowledge_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_node_projects" ADD CONSTRAINT "knowledge_node_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_queries" ADD CONSTRAINT "knowledge_queries_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_queries" ADD CONSTRAINT "knowledge_queries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_insights" ADD CONSTRAINT "voice_insights_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "voice_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_captures" ADD CONSTRAINT "quick_captures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_captures" ADD CONSTRAINT "quick_captures_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_captures" ADD CONSTRAINT "quick_captures_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "voice_recordings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Indexes Prisma cannot express (managed here, not in schema.prisma)
-- ---------------------------------------------------------------------------

-- Approximate nearest-neighbour search over chunk and entity embeddings.
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "knowledge_entities_embedding_hnsw_idx" ON "knowledge_entities" USING hnsw ("embedding" vector_cosine_ops);

-- Full-text search over chunk content. Queries must use the identical expression:
--   to_tsvector('english', content) @@ websearch_to_tsquery('english', $q)
CREATE INDEX "chunks_content_fts_idx" ON "chunks" USING gin (to_tsvector('english', "content"));
