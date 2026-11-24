"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, FolderPlus, Loader2, User } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { MyInvites } from "@/components/team/my-invites";
import { useActiveOrg } from "@/components/team/use-active-org";
import { cn } from "@/lib/utils";

type Step = "workspace" | "project";

function StepIndicator({ step }: { step: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "workspace", label: "Workspace" },
    { id: "project", label: "First project" },
  ];
  return (
    <ol className="flex items-center gap-3 text-sm" aria-label="Onboarding progress">
      {steps.map((s, i) => {
        const current = s.id === step;
        const done = step === "project" && s.id === "workspace";
        return (
          <li key={s.id} className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold",
                current && "border-primary bg-primary text-primary-foreground",
                done && "border-primary text-primary"
              )}
            >
              {i + 1}
            </span>
            <span className={cn(current ? "font-medium" : "text-muted-foreground")}>{s.label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function WorkspaceStep({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const { orgs, list, switchTo } = useActiveOrg();
  const personal = list.find((o) => o.isPersonal) ?? null;
  const [mode, setMode] = useState<"personal" | "team">("personal");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rename = trpc.organization.update.useMutation({ meta: { silent: true } });
  const create = trpc.organization.create.useMutation({ meta: { silent: true } });
  const utils = trpc.useUtils();

  useEffect(() => {
    if (personal && !name) setName(personal.name);
    // Only prefill once, when the personal workspace first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personal?.id]);

  if (orgs.isLoading) return <LoadingState rows={2} label="Loading your workspace" />;
  if (orgs.isError) return <ErrorState message={orgs.error.message} onRetry={() => void orgs.refetch()} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your workspace a name.");
      return;
    }
    try {
      if (mode === "team") {
        const org = await create.mutateAsync({ name: trimmed });
        await switchTo(org.id);
      } else if (personal) {
        if (trimmed !== personal.name) await rename.mutateAsync({ orgId: personal.id, name: trimmed });
        await switchTo(personal.id);
      }
      await utils.organization.listMine.invalidate();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  };

  const pending = rename.isPending || create.isPending;

  return (
    <div className="space-y-6">
      <MyInvites
        onAccepted={async (res) => {
          await switchTo(res.orgId);
          router.push("/projects");
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Set up your workspace</CardTitle>
          <CardDescription>Projects live in a workspace. You can create more organizations and invite people later.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-5" noValidate>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who is this workspace for?</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    { value: "personal", icon: User, title: "Just me", body: "Use your personal workspace. Only you can see its projects." },
                    { value: "team", icon: Building2, title: "My team", body: "Create an organization you can invite colleagues to." },
                  ] as const
                ).map((o) => (
                  <label
                    key={o.value}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-lg border p-4 focus-within:ring-2 focus-within:ring-ring",
                      mode === o.value && "border-primary bg-primary/5"
                    )}
                  >
                    <input
                      type="radio"
                      name="workspace-mode"
                      value={o.value}
                      checked={mode === o.value}
                      onChange={() => {
                        setMode(o.value);
                        if (o.value === "team" && personal && name === personal.name) setName("");
                        if (o.value === "personal" && personal && !name.trim()) setName(personal.name);
                      }}
                      className="sr-only"
                    />
                    <o.icon className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
                    <span>
                      <span className="block font-medium">{o.title}</span>
                      <span className="block text-sm text-muted-foreground">{o.body}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="workspace-name">{mode === "team" ? "Organization name" : "Workspace name"}</Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder={mode === "team" ? "Acme product team" : "My workspace"}
                aria-invalid={!!error}
                aria-describedby={error ? "workspace-error" : undefined}
              />
            </div>
            {error && (
              <p id="workspace-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between">
              <Link href="/projects" className="text-sm text-muted-foreground hover:underline">
                Skip for now
              </Link>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                Continue
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectStep() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = trpc.project.create.useMutation({ meta: { silent: true } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your project a name.");
      return;
    }
    try {
      await create.mutateAsync({ name: trimmed, description: description.trim() || undefined });
      router.push("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the project.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderPlus className="h-5 w-5" aria-hidden />
          Create your first project
        </CardTitle>
        <CardDescription>
          A project collects the customer feedback for one product area or question: interview transcripts, support tickets, notes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Onboarding research, Q3"
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? "project-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="What do you want to learn from this feedback?"
            />
          </div>
          {error && (
            <p id="project-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between">
            <Link href="/projects" className="text-sm text-muted-foreground hover:underline">
              Skip for now
            </Link>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Create project
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function OnboardingFlow() {
  const [step, setStep] = useState<Step>("workspace");
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Welcome to Beacon</h1>
        <p className="text-muted-foreground">Two quick steps and you&apos;re ready to add customer feedback.</p>
        <StepIndicator step={step} />
      </div>
      {step === "workspace" ? <WorkspaceStep onDone={() => setStep("project")} /> : <ProjectStep />}
    </div>
  );
}
