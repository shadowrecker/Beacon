/**
 * Custom AI configuration router. Any member can read their org's
 * configuration; updating requires customAI:manage (OWNER/ADMIN). The
 * configuration is appended to prompts as organization context (see
 * src/server/ai/custom/hook.ts) and never replaces base prompts.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { router, orgProcedure } from "../trpc";
import { can, requireOrgPermission } from "../auth/access";
import { buildCustomizationAddendum, invalidateAICustomization } from "../ai/custom/hook";
import { customAIConfigSchema, normalizeStoredConfig } from "../ai/custom/schema";

const orgId = z.string().min(1).max(64).optional();

export const customAIRouter = router({
  get: orgProcedure.input(z.object({ orgId }).optional()).query(async ({ ctx }) => {
    const row = await ctx.prisma.customAIConfig.findUnique({
      where: { orgId: ctx.org.orgId },
      select: { industryPreset: true, templates: true, taxonomy: true, systemPromptOverride: true, updatedAt: true },
    });
    const config = normalizeStoredConfig(row);
    return {
      config,
      addendum: buildCustomizationAddendum(config),
      updatedAt: row?.updatedAt ?? null,
      canEdit: can(ctx.org.role, "customAI:manage"),
    };
  }),

  update: orgProcedure.input(customAIConfigSchema.extend({ orgId })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, ctx.org.orgId, "customAI:manage");
    const { orgId: _ignored, ...config } = input;
    void _ignored;
    const data = {
      industryPreset: config.industryPreset || null,
      templates: config.templates as unknown as Prisma.InputJsonValue,
      taxonomy: config.taxonomy as unknown as Prisma.InputJsonValue,
      systemPromptOverride: config.systemPromptOverride || null,
    };
    const row = await ctx.prisma.customAIConfig.upsert({
      where: { orgId: ctx.org.orgId },
      create: { orgId: ctx.org.orgId, ...data },
      update: data,
      select: { industryPreset: true, templates: true, taxonomy: true, systemPromptOverride: true, updatedAt: true },
    });
    await invalidateAICustomization(ctx.org.orgId);
    const saved = normalizeStoredConfig(row);
    return { config: saved, addendum: buildCustomizationAddendum(saved), updatedAt: row.updatedAt };
  }),

  /** The organization-context text a draft configuration would add to prompts. */
  preview: orgProcedure.input(z.object({ orgId, sample: customAIConfigSchema })).mutation(({ input }) => ({
    addendum: buildCustomizationAddendum(input.sample),
  })),
});
