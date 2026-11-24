"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RecordingList } from "@/components/voice/recording-list";

export default function MobileRecordingsPage() {
  const [mine, setMine] = useState(true);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Recordings</h1>
        <div className="flex items-center gap-2">
          <Switch id="recordings-mine" checked={mine} onCheckedChange={setMine} />
          <Label htmlFor="recordings-mine" className="text-sm font-normal">
            Only mine
          </Label>
        </div>
      </div>
      <RecordingList
        mine={mine}
        showDelete
        emptyAction={
          <Button asChild>
            <Link href="/m/record">Record now</Link>
          </Button>
        }
      />
    </div>
  );
}
