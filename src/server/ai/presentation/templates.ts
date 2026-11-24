/**
 * Built-in Presentation Templates
 * Six templates for different presentation types and audiences
 */

import type { PresentationAudience, PresentationType } from "@prisma/client";
import { z } from "zod";
import { prisma, type DbClient } from "@/lib/db";

export interface SlideBlueprint {
  slideNumber: number;
  title: string;
  subtitle?: string;
  contentType: "title" | "section" | "content" | "comparison" | "conclusion";
  placeholders: {
    title?: string;
    subtitle?: string;
    bullets?: string;
    image?: string;
    chart?: string;
  };
  notes?: string;
}

export interface PresentationTemplateData {
  name: string;
  description: string;
  audience: PresentationAudience;
  type: PresentationType;
  slides: SlideBlueprint[];
  thumbnailUrl?: string;
  themeColor?: string;
}

export const BUILT_IN_TEMPLATES: Record<string, PresentationTemplateData> = {
  EXECUTIVE_SYNTHESIS: {
    name: "Executive Synthesis",
    description: "High-level synthesis readout for executive leadership",
    audience: "EXECUTIVE",
    type: "SYNTHESIS_READOUT",
    themeColor: "#1e40af",
    slides: [
      {
        slideNumber: 1,
        title: "Synthesis Overview",
        contentType: "title",
        placeholders: {
          title: "Research Synthesis: [Project Name]",
          subtitle: "Key Findings & Strategic Implications",
        },
        notes: "Set context for the research initiative and outcomes",
      },
      {
        slideNumber: 2,
        title: "Executive Summary",
        contentType: "content",
        placeholders: {
          bullets:
            "3-4 key findings with business impact\nStrategic implications\nRecommended next steps",
        },
        notes: "Deliver the headline message in 30 seconds or less",
      },
      {
        slideNumber: 3,
        title: "Key Themes",
        contentType: "content",
        placeholders: {
          bullets:
            "Top 3-4 themes by importance\nBusiness relevance of each theme\nMarket positioning implications",
        },
        notes: "Focus on themes with highest business impact",
      },
      {
        slideNumber: 4,
        title: "Market Opportunity",
        contentType: "content",
        placeholders: {
          bullets: "Market size and growth\nCompetitive positioning\nTime sensitivity",
        },
        notes: "Connect research findings to market dynamics",
      },
      {
        slideNumber: 5,
        title: "Strategic Recommendations",
        contentType: "content",
        placeholders: {
          bullets:
            "Top recommendation with business case\nAlternative approaches\nExpected ROI and timeline",
        },
        notes: "Present clear decision point with supporting data",
      },
      {
        slideNumber: 6,
        title: "Financial Impact",
        contentType: "content",
        placeholders: {
          bullets:
            "Revenue impact potential\nCost implications\nPayback period",
          chart: "Financial projection chart",
        },
        notes: "Quantify the business impact in financial terms",
      },
      {
        slideNumber: 7,
        title: "Implementation Roadmap",
        contentType: "content",
        placeholders: {
          bullets:
            "Phase 1 (Months 1-3): Quick wins\nPhase 2 (Months 4-6): Core initiatives\nPhase 3 (Months 7-12): Long-term strategy",
        },
        notes: "Provide realistic timeline and resource requirements",
      },
      {
        slideNumber: 8,
        title: "Next Steps & Decision",
        contentType: "conclusion",
        placeholders: {
          bullets:
            "Decision required from leadership\nTimeline for decision\nSuccess metrics and KPIs",
        },
        notes: "Clear call-to-action and next meeting",
      },
    ],
  },

  ENGINEERING_HANDOFF: {
    name: "Engineering Handoff",
    description: "Technical deep-dive for engineering teams",
    audience: "ENGINEERING",
    type: "RECOMMENDATION_PITCH",
    themeColor: "#7c3aed",
    slides: [
      {
        slideNumber: 1,
        title: "Technical Initiative Brief",
        contentType: "title",
        placeholders: {
          title: "Engineering Initiative: [Project Name]",
          subtitle: "Technical Specification & Implementation Plan",
        },
        notes: "Orient engineers to the problem and solution space",
      },
      {
        slideNumber: 2,
        title: "Problem Statement",
        contentType: "content",
        placeholders: {
          bullets:
            "Current system limitations\nPerformance/scalability issues\nTechnical debt implications",
        },
        notes: "Define the technical problem clearly",
      },
      {
        slideNumber: 3,
        title: "Proposed Solution",
        contentType: "content",
        placeholders: {
          bullets:
            "Architecture overview\nKey components and interactions\nTechnology stack",
          image: "Architecture diagram",
        },
        notes: "Explain the technical approach and design decisions",
      },
      {
        slideNumber: 4,
        title: "Technical Feasibility",
        contentType: "content",
        placeholders: {
          bullets:
            "Proof of concept results\nRisk assessment\nMitigation strategies",
        },
        notes: "Address technical risks and dependencies",
      },
      {
        slideNumber: 5,
        title: "Performance Metrics",
        contentType: "content",
        placeholders: {
          bullets:
            "Current baseline metrics\nTarget performance improvements\nBenchmark comparisons",
          chart: "Performance improvement chart",
        },
        notes: "Quantify expected performance gains",
      },
      {
        slideNumber: 6,
        title: "Implementation Timeline",
        contentType: "content",
        placeholders: {
          bullets:
            "Phase 1 (Weeks 1-4): Core infrastructure\nPhase 2 (Weeks 5-8): Feature implementation\nPhase 3 (Weeks 9-12): Testing & optimization",
        },
        notes: "Provide realistic sprint-level breakdown",
      },
      {
        slideNumber: 7,
        title: "Testing & Validation",
        contentType: "content",
        placeholders: {
          bullets:
            "Unit test coverage targets\nIntegration testing strategy\nProduction validation plan",
        },
        notes: "Detail quality assurance approach",
      },
      {
        slideNumber: 8,
        title: "Dependencies & Resources",
        contentType: "content",
        placeholders: {
          bullets:
            "Team size and expertise needed\nExternal dependencies\nTooling and infrastructure requirements",
        },
        notes: "Clarify resource requirements",
      },
      {
        slideNumber: 9,
        title: "Engineering Roadmap",
        contentType: "conclusion",
        placeholders: {
          bullets:
            "Next engineering review date\nKey decision points\nSuccess criteria",
        },
        notes: "Confirm alignment and move forward",
      },
    ],
  },

  QBR_TEMPLATE: {
    name: "Quarterly Business Review",
    description: "Comprehensive QBR for stakeholder alignment",
    audience: "BOARD",
    type: "QBR",
    themeColor: "#059669",
    slides: [
      {
        slideNumber: 1,
        title: "Q[X] Business Review",
        contentType: "title",
        placeholders: {
          title: "Q[X] 20[XX] Business Review",
          subtitle: "Executive Summary & Strategic Update",
        },
        notes: "Set the agenda and tone for the review",
      },
      {
        slideNumber: 2,
        title: "Strategic Highlights",
        contentType: "content",
        placeholders: {
          bullets:
            "Top 3 strategic wins this quarter\nMarket position improvements\nCustomer success stories",
        },
        notes: "Lead with achievements and momentum",
      },
      {
        slideNumber: 3,
        title: "Financial Performance",
        contentType: "content",
        placeholders: {
          bullets:
            "Revenue vs. target\nUnit economics trends\nCash runway and burn rate",
          chart: "Financial dashboard",
        },
        notes: "Provide complete financial picture",
      },
      {
        slideNumber: 4,
        title: "Product & Customer Metrics",
        contentType: "content",
        placeholders: {
          bullets:
            "User growth and retention\nProduct adoption metrics\nNPS and customer satisfaction",
          chart: "Product metrics dashboard",
        },
        notes: "Demonstrate customer traction and satisfaction",
      },
      {
        slideNumber: 5,
        title: "Market & Competitive Landscape",
        contentType: "content",
        placeholders: {
          bullets:
            "Market trends and opportunities\nCompetitive moves\nOur positioning improvements",
        },
        notes: "Connect to market context and strategy",
      },
      {
        slideNumber: 6,
        title: "Product Roadmap Update",
        contentType: "content",
        placeholders: {
          bullets:
            "Q3 accomplishments vs. roadmap\nQ4 key initiatives\nPriority shifts based on market feedback",
          chart: "Roadmap timeline",
        },
        notes: "Show progress on strategic initiatives",
      },
      {
        slideNumber: 7,
        title: "Risks & Mitigations",
        contentType: "content",
        placeholders: {
          bullets:
            "Key risks to monitor\nMitigation strategies in place\nContingency plans",
        },
        notes: "Address risks proactively with solutions",
      },
      {
        slideNumber: 8,
        title: "Q4 Objectives & KPIs",
        contentType: "content",
        placeholders: {
          bullets:
            "Strategic objectives for Q4\nKey success metrics\nResource requirements",
          chart: "OKR dashboard",
        },
        notes: "Align team and board on next quarter",
      },
      {
        slideNumber: 9,
        title: "Discussion & Decisions",
        contentType: "conclusion",
        placeholders: {
          bullets:
            "Key decisions needed from board\nOpen questions and discussion topics\nNext steps and timeline",
        },
        notes: "Facilitate board discussion and decisions",
      },
    ],
  },

  CUSTOMER_WINBACK: {
    name: "Customer Win-Back",
    description: "Value proposition for at-risk customers",
    audience: "CUSTOMER",
    type: "CUSTOM",
    themeColor: "#dc2626",
    slides: [
      {
        slideNumber: 1,
        title: "Partnership Renewal",
        contentType: "title",
        placeholders: {
          title: "Renewing Our Partnership",
          subtitle: "New Features, Improved Value, Strategic Alignment",
        },
        notes: "Acknowledge the relationship and pivot to new value",
      },
      {
        slideNumber: 2,
        title: "Customer Success Review",
        contentType: "content",
        placeholders: {
          bullets:
            "Your business goals and metrics\nProgress made together\nValue delivered to date",
        },
        notes: "Acknowledge past success",
      },
      {
        slideNumber: 3,
        title: "Market Changes & Opportunities",
        contentType: "content",
        placeholders: {
          bullets:
            "How your market has evolved\nNew competitive pressures\nEmerging customer needs",
        },
        notes: "Contextualize why renewal is timely",
      },
      {
        slideNumber: 4,
        title: "Our Product Evolution",
        contentType: "content",
        placeholders: {
          bullets:
            "Major features released\nPerformance and reliability improvements\nInnovations in your industry",
          image: "Product evolution timeline",
        },
        notes: "Highlight how we've improved since last discussion",
      },
      {
        slideNumber: 5,
        title: "New Value Opportunities",
        contentType: "content",
        placeholders: {
          bullets:
            "Use case 1: [Specific to your industry]\nUse case 2: [Specific to their company size]\nUse case 3: [Specific to their strategic goals]",
        },
        notes: "Address specific opportunities for their business",
      },
      {
        slideNumber: 6,
        title: "Success Stories",
        contentType: "content",
        placeholders: {
          bullets:
            "Similar company in your industry: [result]\nCompany of your size: [result]\nCompany with your goals: [result]",
        },
        notes: "Build confidence with relevant success stories",
      },
      {
        slideNumber: 7,
        title: "Investment & ROI",
        contentType: "content",
        placeholders: {
          bullets:
            "Renewal investment with new benefits\nProjected ROI for your use case\nFlexible options and pricing",
          chart: "ROI projection for their scenario",
        },
        notes: "Make financial case for renewal",
      },
      {
        slideNumber: 8,
        title: "Next Steps",
        contentType: "conclusion",
        placeholders: {
          bullets:
            "Proposed implementation timeline\nDedicated support for your renewal\nScheduled follow-up meeting",
        },
        notes: "Move toward renewal conversation",
      },
    ],
  },

  LAUNCH_READOUT: {
    name: "Launch Readout",
    description: "Post-launch review and impact analysis",
    audience: "EXECUTIVE",
    type: "LAUNCH_BRIEF",
    themeColor: "#06b6d4",
    slides: [
      {
        slideNumber: 1,
        title: "Product Launch Summary",
        contentType: "title",
        placeholders: {
          title: "[Feature/Product] Launch Review",
          subtitle: "Results, Learnings, & Next Steps",
        },
        notes: "Celebrate the launch and preview results",
      },
      {
        slideNumber: 2,
        title: "Launch Overview",
        contentType: "content",
        placeholders: {
          bullets:
            "What we launched and why\nTarget audience and use cases\nLaunch date and timeline",
        },
        notes: "Provide context for the launch",
      },
      {
        slideNumber: 3,
        title: "Launch Metrics",
        contentType: "content",
        placeholders: {
          bullets:
            "Adoption in first week/month\nCustomer feedback sentiment\nSales/revenue impact",
          chart: "Launch performance dashboard",
        },
        notes: "Show early adoption and reception",
      },
      {
        slideNumber: 4,
        title: "Customer Feedback",
        contentType: "content",
        placeholders: {
          bullets:
            "Top 3 positive feedback themes\nMost requested enhancements\nPotential issues or concerns",
        },
        notes: "Summarize key customer reactions",
      },
      {
        slideNumber: 5,
        title: "Competitive Impact",
        contentType: "content",
        placeholders: {
          bullets:
            "How competitors reacted\nOur unique positioning\nMarket share implications",
        },
        notes: "Assess competitive landscape post-launch",
      },
      {
        slideNumber: 6,
        title: "Post-Launch Roadmap",
        contentType: "content",
        placeholders: {
          bullets:
            "Immediate fixes/iterations (weeks 1-4)\nPhase 2 enhancements (months 2-3)\nLong-term roadmap implications",
        },
        notes: "Show commitment to post-launch improvements",
      },
      {
        slideNumber: 7,
        title: "Lessons Learned",
        contentType: "content",
        placeholders: {
          bullets:
            "What went well\nWhat we would do differently\nProcess improvements for future launches",
        },
        notes: "Institutional learning and improvement",
      },
      {
        slideNumber: 8,
        title: "Financial Impact",
        contentType: "content",
        placeholders: {
          bullets:
            "Revenue impact to date\nProjected 6-month impact\nROI vs. launch investment",
          chart: "Financial projection",
        },
        notes: "Quantify business impact",
      },
      {
        slideNumber: 9,
        title: "Next Steps",
        contentType: "conclusion",
        placeholders: {
          bullets:
            "Approved enhancements and timeline\nResource allocation\nNext review date",
        },
        notes: "Confirm path forward",
      },
    ],
  },

  INVESTOR_UPDATE: {
    name: "Investor Update",
    description: "Comprehensive update for investor audiences",
    audience: "INVESTOR",
    type: "CUSTOM",
    themeColor: "#ea580c",
    slides: [
      {
        slideNumber: 1,
        title: "Company Update",
        contentType: "title",
        placeholders: {
          title: "Company Update - [Month/Quarter]",
          subtitle: "Progress, Market Position, Growth Trajectory",
        },
        notes: "Set positive tone for investor update",
      },
      {
        slideNumber: 2,
        title: "Strategic Progress",
        contentType: "content",
        placeholders: {
          bullets:
            "Mission and vision alignment\nKey strategic milestones achieved\nMarket position improvements",
        },
        notes: "Show alignment with investor thesis",
      },
      {
        slideNumber: 3,
        title: "Financial Performance",
        contentType: "content",
        placeholders: {
          bullets:
            "Revenue growth (MoM, YoY)\nPath to profitability\nUnit economics trends",
          chart: "Revenue and growth trajectory",
        },
        notes: "Demonstrate financial momentum",
      },
      {
        slideNumber: 4,
        title: "Market Opportunity",
        contentType: "content",
        placeholders: {
          bullets:
            "TAM analysis and growth\nMarket penetration progress\nGeographic expansion opportunities",
          chart: "TAM and market size",
        },
        notes: "Reinforce investment thesis",
      },
      {
        slideNumber: 5,
        title: "Product & Customer Traction",
        contentType: "content",
        placeholders: {
          bullets:
            "User/customer growth metrics\nRetention and engagement trends\nProduct-market fit indicators",
          chart: "Traction metrics",
        },
        notes: "Show customer validation",
      },
      {
        slideNumber: 6,
        title: "Competitive Positioning",
        contentType: "content",
        placeholders: {
          bullets:
            "Competitive advantages\nMarket differentiation\nDefensive moats",
        },
        notes: "Highlight competitive defensibility",
      },
      {
        slideNumber: 7,
        title: "Team & Execution",
        contentType: "content",
        placeholders: {
          bullets:
            "Key hires and leadership additions\nTeam expertise and depth\nCultural highlights",
        },
        notes: "Showcase team capability",
      },
      {
        slideNumber: 8,
        title: "Forward Outlook",
        contentType: "content",
        placeholders: {
          bullets:
            "Next 12-month key initiatives\nExpected growth trajectory\nKey metrics to track",
          chart: "Forward growth projection",
        },
        notes: "Provide outlook for tracking progress",
      },
      {
        slideNumber: 9,
        title: "Investment Opportunity",
        contentType: "conclusion",
        placeholders: {
          bullets:
            "Funding ask (if applicable) and use of funds\nKey milestones funded\nNext steps",
        },
        notes: "Call to action for investors",
      },
    ],
  },
};

export const BUILTIN_PREFIX = "builtin:";
const THEME_HEX = /^#[0-9A-Fa-f]{6}$/;

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  audience: PresentationAudience;
  type: PresentationType;
  slideCount: number;
  themeColor: string | null;
  builtIn: boolean;
  outline: string[];
}

export interface TemplateOutlineSlide {
  title: string;
  contentType: SlideBlueprint["contentType"];
  guidance: string;
}

export interface ResolvedTemplate {
  id: string;
  name: string;
  themeColor: string | null;
  outline: TemplateOutlineSlide[];
}

function blueprintGuidance(b: SlideBlueprint): string {
  return [b.placeholders.bullets?.replace(/\n/g, "; "), b.placeholders.chart ? `chart: ${b.placeholders.chart}` : "", b.notes]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 400);
}

export function builtInTemplateSummaries(): TemplateSummary[] {
  return Object.entries(BUILT_IN_TEMPLATES).map(([key, t]) => ({
    id: `${BUILTIN_PREFIX}${key}`,
    name: t.name,
    description: t.description,
    audience: t.audience,
    type: t.type,
    slideCount: t.slides.length,
    themeColor: t.themeColor && THEME_HEX.test(t.themeColor) ? t.themeColor.toUpperCase() : null,
    builtIn: true,
    outline: t.slides.map((s) => s.title),
  }));
}


const storedBlueprint = z.object({
  title: z.string().min(1).max(200),
  contentType: z.enum(["title", "section", "content", "comparison", "conclusion"]).catch("content"),
  notes: z.string().max(1_000).optional(),
  placeholders: z.record(z.string(), z.string().max(1_000)).optional(),
});

/** Parse a stored PresentationTemplate.structure leniently (bounded). */
export function outlineFromStructure(structure: unknown): TemplateOutlineSlide[] {
  const list = Array.isArray(structure)
    ? structure
    : structure && typeof structure === "object" && Array.isArray((structure as { slides?: unknown }).slides)
      ? (structure as { slides: unknown[] }).slides
      : [];
  const out: TemplateOutlineSlide[] = [];
  for (const raw of list.slice(0, 30)) {
    const parsed = storedBlueprint.safeParse(raw);
    if (!parsed.success) continue;
    const b = parsed.data;
    out.push({
      title: b.title,
      contentType: b.contentType,
      guidance: [b.placeholders?.bullets?.replace(/\n/g, "; "), b.notes].filter(Boolean).join(" | ").slice(0, 400),
    });
  }
  return out;
}

/**
 * Resolve a template id ("builtin:KEY" or a PresentationTemplate id visible to
 * the org: public, or owned by the org). Null when not found or not visible.
 */
export async function resolveTemplate(templateId: string | null | undefined, orgId: string, db: DbClient = prisma): Promise<ResolvedTemplate | null> {
  if (!templateId) return null;
  if (templateId.startsWith(BUILTIN_PREFIX)) {
    const t = BUILT_IN_TEMPLATES[templateId.slice(BUILTIN_PREFIX.length)];
    if (!t) return null;
    return {
      id: templateId,
      name: t.name,
      themeColor: t.themeColor && THEME_HEX.test(t.themeColor) ? t.themeColor.toUpperCase() : null,
      outline: t.slides.map((b) => ({ title: b.title, contentType: b.contentType, guidance: blueprintGuidance(b) })),
    };
  }
  const row = await db.presentationTemplate.findFirst({
    where: { id: templateId, OR: [{ isPublic: true }, { orgId }] },
    select: { id: true, name: true, structure: true },
  });
  if (!row) return null;
  const outline = outlineFromStructure(row.structure);
  return outline.length ? { id: row.id, name: row.name, themeColor: null, outline } : null;
}
