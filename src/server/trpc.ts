import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS, type RateLimitRule } from "@/lib/rate-limit";
import { getMembership, type Membership } from "./auth/access";
import type { Context, ContextUser } from "./context";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error, ctx }) {
    // Never leak internals (Prisma messages, stack traces) to clients.
    const isInternal = error.code === "INTERNAL_SERVER_ERROR";
    if (isInternal) {
      logger.error("trpc internal error", { requestId: ctx?.requestId, err: error.cause ?? error });
    }
    return {
      ...shape,
      message: isInternal ? "Something went wrong. Please try again." : shape.message,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        path: shape.data.path,
        requestId: ctx?.requestId,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  return next({ ctx: { ...ctx, user: ctx.user as ContextUser } });
});

/** Any signed-in user. Resource access is still checked per procedure. */
export const protectedProcedure = t.procedure.use(authed);

/**
 * Signed-in user acting within an active organization. The org comes from the
 * `x-org-id` header (or input.orgId when the procedure takes one) and membership
 * is verified here; falls back to the user's personal org.
 */
export const orgProcedure = protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
  const raw = (await getRawInput().catch(() => undefined)) as { orgId?: unknown } | undefined;
  const fromInput = typeof raw?.orgId === "string" ? raw.orgId : null;
  const requested = fromInput ?? ctx.requestedOrgId;

  let membership: Membership | null = null;
  if (requested) {
    membership = await getMembership(ctx.prisma, ctx.user.id, requested);
    if (!membership) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
  } else {
    const personal = await ctx.prisma.orgMember.findFirst({
      where: { userId: ctx.user.id, joinedAt: { not: null }, organization: { isPersonal: true } },
      select: { orgId: true, role: true },
    });
    if (!personal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No organization available" });
    membership = { orgId: personal.orgId, role: personal.role };
  }
  return next({ ctx: { ...ctx, org: membership } });
});

/** Per-user rate limit middleware. */
export function rateLimited(rule: RateLimitRule) {
  return t.middleware(async ({ ctx, next }) => {
    const subject = ctx.user?.id ?? ctx.ip ?? "anonymous";
    const res = await checkRateLimit(rule, subject);
    if (!res.allowed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded. Try again in ${Math.ceil(res.resetMs / 1000)}s.`,
      });
    }
    return next();
  });
}

/** Procedures that trigger LLM work (synchronously or by enqueueing a job). */
export const llmProcedure = protectedProcedure
  .use(rateLimited(RATE_LIMITS.llm))
  .use(rateLimited(RATE_LIMITS.llmHourly));

/** Procedures that cause outbound side effects (emails, webhook tests, invites). */
export const outboundProcedure = protectedProcedure.use(rateLimited(RATE_LIMITS.outbound));
