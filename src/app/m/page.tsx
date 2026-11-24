"use client";

import Link from "next/link";
import { ChevronRight, ListMusic, Mic, PenLine } from "lucide-react";
import { InstallPrompt } from "@/components/voice/install-prompt";
import { RecordingList } from "@/components/voice/recording-list";

const ACTIONS = [
  { href: "/m/record", title: "Record a conversation", body: "Transcribed with speaker labels and analyzed for insights.", icon: Mic },
  { href: "/m/quick", title: "Quick capture", body: "Jot down a thought or a call highlight.", icon: PenLine },
  { href: "/m/recordings", title: "My recordings", body: "Transcripts, insights, download and share.", icon: ListMusic },
] as const;

export default function MobileHome() {
  return (
    <div className="space-y-6">
      <InstallPrompt />
      <ul className="space-y-3">
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <li key={a.href}>
              <Link href={a.href} className="flex items-center gap-4 rounded-xl border p-4 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{a.title}</span>
                  <span className="block text-sm text-muted-foreground">{a.body}</span>
                </span>
                <ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
      <section aria-labelledby="recent-heading" className="space-y-3">
        <h2 id="recent-heading" className="font-semibold">
          Recent recordings
        </h2>
        <RecordingList mine limit={3} />
      </section>
    </div>
  );
}
