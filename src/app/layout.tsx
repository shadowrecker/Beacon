import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { TRPCProvider } from "@/lib/trpc/provider";
import { Toaster } from "@/components/ui/toast";
import { ServiceWorkerRegistrar } from "@/components/layout/service-worker-registrar";
import { PostHogPageviews } from "@/components/layout/posthog-pageviews";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: { default: "Beacon — AI Product Intelligence", template: "%s · Beacon" },
  description:
    "AI-powered product decision intelligence: synthesize customer feedback into evidence-backed product recommendations.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Beacon" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

// Every page depends on the signed-in user (Clerk), so nothing is prerendered at
// build time. This also keeps `next build` free of runtime secrets.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#3B82F6",
};

// Applies the saved/system theme before first paint (static string, no user input).
const themeScript = `(function(){try{var t=localStorage.getItem('beacon.theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ClerkProvider>
          <TRPCProvider>
            {children}
            <Toaster />
            <PostHogPageviews />
          </TRPCProvider>
          <ServiceWorkerRegistrar />
        </ClerkProvider>
      </body>
    </html>
  );
}
