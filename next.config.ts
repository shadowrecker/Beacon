import type { NextConfig } from "next";

/**
 * Security headers applied to every response.
 *
 * The CSP allows Clerk (auth UI and API), PostHog and Sentry, which are the only
 * third-party origins the browser talks to. Everything else (Anthropic, OpenAI,
 * Deepgram, S3 uploads via presigned POST) is either server-side or covered by
 * connect-src for the storage endpoint.
 */
function securityHeaders() {
  const storageOrigin = process.env.S3_PUBLIC_ORIGIN ?? "";
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
  const isDev = process.env.NODE_ENV !== "production";

  const csp = [
    "default-src 'self'",
    // Next.js inline bootstrap + Clerk scripts. 'unsafe-eval' only in dev (React refresh).
    `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ""} https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://img.clerk.com",
    "font-src 'self' data:",
    `connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com ${posthogHost} https://*.ingest.sentry.io https://*.ingest.us.sentry.io ${storageOrigin}`,
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]
    .join("; ")
    .replace(/\s{2,}/g, " ");

  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
    },
  ];
}

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  eslint: {
    dirs: ["src"],
  },
  images: {
    // next/image is not used; disable the optimizer so /_next/image cannot be
    // abused as an open image proxy.
    unoptimized: true,
  },
  serverExternalPackages: ["pdf-parse", "pdfkit", "pptxgenjs", "bullmq", "ioredis"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default config;
