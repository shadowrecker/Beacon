import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { generateObject } from "@/server/ai/client";
import { registerAICustomization } from "@/server/ai/custom/hook";
import { llmCalls, scriptLLM } from "../helpers/doubles";
import { callerFor } from "../helpers/caller";
import { createTenant, memberOf, type Tenant } from "./helpers";

const BASE_SYSTEM = "You analyze customer feedback. Follow the output schema.";

async function systemPromptFor(orgId: string): Promise<string> {
  scriptLLM("test.custom", () => ({ ok: true }));
  await generateObject({ feature: "test.custom", orgId, system: BASE_SYSTEM, prompt: "p", schema: z.object({ ok: z.boolean() }) });
  return llmCalls[llmCalls.length - 1].system;
}

const config = (industry: string) => ({
  industryPreset: industry,
  templates: {
    terminology: { ARR: "annual recurring revenue" },
    focusAreas: ["onboarding", "billing"],
    tone: "concise and direct",
    outputPreferences: "Lead with the business impact.",
  },
  taxonomy: { categories: [{ name: "Billing", description: "Invoices and payments" }, { name: "Onboarding" }] },
  systemPromptOverride: "Our customers are finance teams.",
});

let a: Tenant;
let b: Tenant;

beforeAll(() => {
  registerAICustomization();
});

beforeEach(async () => {
  a = await createTenant("Acme");
  b = await createTenant("Globex");
});

describe("custom AI configuration", () => {
  it("requires OWNER/ADMIN to update; members get a read-only view", async () => {
    const member = await memberOf(a.orgId, "MEMBER");
    const admin = await memberOf(a.orgId, "ADMIN");
    await expect(callerFor(member, a.orgId).customAI.update(config("Fintech"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(b.owner, a.orgId).customAI.update(config("Fintech"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await callerFor(admin, a.orgId).customAI.update(config("Fintech"));
    const view = await callerFor(member, a.orgId).customAI.get();
    expect(view.canEdit).toBe(false);
    expect(view.config.industryPreset).toBe("Fintech");
    expect(view.addendum).toContain("Organization context");
    expect((await callerFor(admin, a.orgId).customAI.get()).canEdit).toBe(true);
    expect(await prisma.customAIConfig.count({ where: { orgId: a.orgId } })).toBe(1);
  });

  it("appends org context (never replacing the base prompt) and invalidates the cache on update", async () => {
    await callerFor(a.owner, a.orgId).customAI.update(config("Fintech"));
    const first = await systemPromptFor(a.orgId);
    expect(first.startsWith(BASE_SYSTEM)).toBe(true);
    expect(first).toContain("Industry: Fintech.");
    expect(first).toContain('"ARR" means annual recurring revenue');
    expect(first).toContain("Billing (Invoices and payments)");
    expect(first).toContain("Additional guidance from administrators: Our customers are finance teams.");

    await callerFor(a.owner, a.orgId).customAI.update(config("Healthcare"));
    const second = await systemPromptFor(a.orgId);
    expect(second).toContain("Industry: Healthcare.");
    expect(second).not.toContain("Fintech");

    // Never leaks to another org.
    expect(await systemPromptFor(b.orgId)).toBe(BASE_SYSTEM);
  });

  it("validates sizes and shape", async () => {
    const caller = callerFor(a.owner, a.orgId);
    await expect(caller.customAI.update({ ...config("x"), systemPromptOverride: "x".repeat(2001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const terminology = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`t${i}`, "v"]));
    await expect(caller.customAI.update({ ...config("x"), templates: { ...config("x").templates, terminology } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.customAI.update({ ...config("x"), industryPreset: "x".repeat(101) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.customAI.update({ ...config("x"), taxonomy: { categories: Array.from({ length: 41 }, (_, i) => ({ name: `c${i}` })) } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.customAI.update({ ...config("x"), extra: true } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("previews the addendum for a draft without saving it", async () => {
    const { addendum } = await callerFor(a.owner, a.orgId).customAI.preview({ sample: config("Developer tools") });
    expect(addendum).toContain("Industry: Developer tools.");
    expect(await prisma.customAIConfig.count()).toBe(0);
    const empty = await callerFor(a.owner, a.orgId).customAI.preview({ sample: {} });
    expect(empty.addendum).toBeNull();
  });
});
