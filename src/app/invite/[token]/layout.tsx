import type { Metadata } from "next";

// The URL carries a secret token: never leak it via Referer, never index it.
export const metadata: Metadata = {
  title: "Invitation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">{children}</div>;
}
