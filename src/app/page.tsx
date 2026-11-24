import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight, FileText, Layers, Lightbulb, MessageSquare, Quote, Users, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

const FEATURES = [
  {
    icon: FileText,
    title: "Bring your feedback together",
    body: "Upload interview transcripts, support tickets, notes and call recordings, or sync them from tools like Intercom, Zendesk, Gong and Slack.",
  },
  {
    icon: Layers,
    title: "See the themes",
    body: "Beacon groups what customers say into themes and pain points, each linked to the exact quotes it came from so you can check the evidence.",
  },
  {
    icon: Lightbulb,
    title: "Decide what to build",
    body: "Turn themes into recommendations with an estimated impact and confidence, then track what you accepted, shipped and learned.",
  },
  {
    icon: MessageSquare,
    title: "Ask questions of your research",
    body: "Ask in plain language and get answers with citations back to the source documents.",
  },
  {
    icon: Users,
    title: "Work as a team",
    body: "Share projects in an organization, comment and @mention teammates, and follow activity across every project.",
  },
  {
    icon: Quote,
    title: "Stay grounded in evidence",
    body: "Every insight keeps its source. AI output is a starting point for your judgment, not a replacement for it.",
  },
] as const;

const STEPS = [
  { title: "Create a project", body: "One project per product area or research question." },
  { title: "Add feedback", body: "Upload files or connect an integration." },
  { title: "Run a synthesis", body: "Review themes, quotes and recommendations, then share them with your team." },
] as const;

export default async function Home() {
  const { userId } = await auth();
  const signedIn = !!userId;

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
              <Zap className="h-5 w-5 text-white" aria-hidden />
            </span>
            <span className="text-lg font-bold">Beacon</span>
          </Link>
          <div className="flex items-center gap-2">
            {signedIn ? (
              <Button asChild>
                <Link href="/projects">
                  Go to your projects
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
                </Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" asChild>
                  <Link href="/sign-in">Sign in</Link>
                </Button>
                <Button asChild>
                  <Link href="/sign-up">Get started</Link>
                </Button>
              </>
            )}
          </div>
        </nav>
      </header>

      <main id="main">
        <section className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 md:py-28">
          <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
            Turn customer feedback into{" "}
            <span className="bg-gradient-to-r from-blue-500 to-purple-600 bg-clip-text text-transparent">product decisions</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Beacon reads your interviews, tickets and notes, finds the recurring themes with the quotes behind them, and helps your team
            decide what to build next.
          </p>
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
            {signedIn ? (
              <Button size="lg" asChild>
                <Link href="/projects">
                  Open Beacon
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
                </Link>
              </Button>
            ) : (
              <>
                <Button size="lg" asChild>
                  <Link href="/sign-up">
                    Create a free account
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link href="/sign-in">Sign in</Link>
                </Button>
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="features-heading" className="border-t bg-muted/30">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <h2 id="features-heading" className="text-center text-3xl font-bold">
              What Beacon does
            </h2>
            <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <li key={f.title} className="rounded-lg border bg-background p-6">
                  <f.icon className="h-6 w-6 text-primary" aria-hidden />
                  <h3 className="mt-4 font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="how-heading" className="mx-auto max-w-4xl px-4 py-20 sm:px-6">
          <h2 id="how-heading" className="text-center text-3xl font-bold">
            How it works
          </h2>
          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">
                  {i + 1}
                </span>
                <h3 className="mt-4 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
          {!signedIn && (
            <div className="mt-12 text-center">
              <Button size="lg" asChild>
                <Link href="/sign-up">Get started</Link>
              </Button>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <p>Beacon: AI-assisted product decision intelligence.</p>
          <nav aria-label="Footer" className="flex gap-4">
            <Link href="/sign-in" className="hover:text-foreground">
              Sign in
            </Link>
            <Link href="/sign-up" className="hover:text-foreground">
              Create account
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
