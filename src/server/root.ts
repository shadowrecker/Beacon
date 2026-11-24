import { router } from "./trpc";
import { projectRouter } from "./routers/project";
import { documentRouter } from "./routers/document";
import { synthesisRouter } from "./routers/synthesis";
import { recommendationRouter } from "./routers/recommendation";
import { queryRouter } from "./routers/query";
import { userRouter } from "./routers/user";
import { integrationRouter } from "./routers/integration";
import { competitiveRouter } from "./routers/competitive";
import { roadmapRouter } from "./routers/roadmap";
import { organizationRouter } from "./routers/organization";
import { teamRouter } from "./routers/team";
import { analyticsRouter } from "./routers/analytics";
import { collaborationRouter } from "./routers/collaboration";
import { outcomeRouter } from "./routers/outcome";
import { coachRouter } from "./routers/coach";
import { workflowRouter } from "./routers/workflow";
import { presentationRouter } from "./routers/presentation";
import { marketplaceRouter } from "./routers/marketplace";
import { sentimentRouter } from "./routers/sentiment";
import { knowledgeRouter } from "./routers/knowledge";
import { voiceRouter } from "./routers/voice";
import { apiKeyRouter } from "./routers/apiKey";
import { webhookRouter } from "./routers/webhook";
import { handoffRouter } from "./routers/handoff";
import { customAIRouter } from "./routers/customAI";
import { jobRouter } from "./routers/job";

export const appRouter = router({
  project: projectRouter,
  document: documentRouter,
  synthesis: synthesisRouter,
  recommendation: recommendationRouter,
  query: queryRouter,
  user: userRouter,
  integration: integrationRouter,
  competitive: competitiveRouter,
  roadmap: roadmapRouter,
  organization: organizationRouter,
  team: teamRouter,
  analytics: analyticsRouter,
  collaboration: collaborationRouter,
  outcome: outcomeRouter,
  coach: coachRouter,
  workflow: workflowRouter,
  presentation: presentationRouter,
  marketplace: marketplaceRouter,
  sentiment: sentimentRouter,
  knowledge: knowledgeRouter,
  voice: voiceRouter,
  apiKey: apiKeyRouter,
  webhook: webhookRouter,
  handoff: handoffRouter,
  customAI: customAIRouter,
  job: jobRouter,
});

export type AppRouter = typeof appRouter;
