import type { Metadata } from "next";
import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import { Zap } from "lucide-react";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <Link href="/" className="flex items-center gap-2" aria-label="Beacon home">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Zap className="h-5 w-5 text-white" aria-hidden />
        </span>
        <span className="text-xl font-bold">Beacon</span>
      </Link>
      <main id="main" className="w-full max-w-md">
        <SignIn
          signUpUrl="/sign-up"
          fallbackRedirectUrl="/projects"
          appearance={{ elements: { rootBox: "w-full", cardBox: "w-full shadow-sm" } }}
        />
      </main>
    </div>
  );
}
