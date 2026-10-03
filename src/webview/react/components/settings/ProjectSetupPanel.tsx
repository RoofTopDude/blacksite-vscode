import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, Loader2, RefreshCw, Terminal, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProjectSetupState } from "@/lib/protocol";
import type { ProjectVerdict, Recommendation, SetupRunStep } from "../../../../toolchains/setup-types";
import { Note, Segmented } from "./common";

/* Settings › Project setup: a guided walk from "what do my projects need" to a terminal that
   installs it. Five steps, each answering one question:

     1. We found      — which projects, what each asks for, and where it says so
     2. Your machine  — what is installed, with versions, and which projects each satisfies
     3. Recommended   — the least work that gets everything working, pre-selected conservatively
     4. Review        — the exact commands, where files go, what asks for a password, how to undo
     5. Done          — what happened, step by step, and what still needs attention

   Nothing is installed from this panel except editor extensions. Everything else runs in a
   terminal the user watches, after typing Y there. */

type StepId = 0 | 1 | 2 | 3 | 4;
const STEPS = ["We found", "Your machine", "Recommended", "Review", "Done"] as const;
type Filter = "attention" | "inplay" | "all";
const PAGE = 40;

function StatusIcon({ kind }: { kind: "ok" | "warn" | "fail" | "pending" }) {
  if (kind === "ok") return <CheckCircle2 className="size-3.5 shrink-0" style={{ color: "var(--s-ok)" }} aria-label="OK" />;
  if (kind === "warn") return <AlertTriangle className="size-3.5 shrink-0" style={{ color: "var(--s-warn)" }} aria-label="Needs attention" />;
  if (kind === "fail") return <XCircle className="size-3.5 shrink-0" style={{ color: "var(--s-err, #f87171)" }} aria-label="Failed" />;
  return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" aria-label="Not run" />;
}

function itemKind(kind: string): "ok" | "warn" | "fail" {
  if (kind === "ok" || kind === "auto") return "ok";
  if (kind === "missing" || kind === "too_old") return "fail";
  return "warn";
}

function Stepper({ step, onStep, canReach }: { step: StepId; onStep: (step: StepId) => void; canReach: (step: StepId) => boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Setup steps">
      {STEPS.map((label, index) => {
        const id = index as StepId;
        const reachable = canReach(id);
        return (
          <li key={label} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!reachable}
              aria-current={step === id ? "step" : undefined}
              onClick={() => onStep(id)}
              className={cn(
                "rounded-full border px-2 py-0.5 font-medium transition-colors",
                step === id ? "border-primary/50 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                !reachable && "opacity-40",
              )}
            >
              {index + 1}. {label}
            </button>
            {index < STEPS.length - 1 && <ChevronRight className="size-3 text-muted-foreground/60" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function ProjectRow({ project }: { project: ProjectVerdict }) {
  const [open, setOpen] = useState(project.needsAttention && project.inPlay);
  return (
    <li className="rounded-md border border-border bg-white/[0.02]">
      <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusIcon kind={project.needsAttention ? "warn" : "ok"} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{project.display}</span>
        {project.inPlay && <span className="rounded-full bg-primary/10 px-1.5 text-2xs text-primary">in use</span>}
        <span className="shrink-0 text-2xs text-muted-foreground">{project.toolchains.join(" · ")}</span>
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="space-y-1 border-t border-border px-2 py-1.5">
          {project.items.length === 0 && <li className="text-xs text-muted-foreground">Nothing to check.</li>}
          {project.items.map((item, index) => (
            <li key={index} className="flex gap-1.5 text-xs leading-snug">
              <StatusIcon kind={itemKind(item.kind)} />
              <span className="min-w-0 flex-1 text-foreground/90">
                {item.message}
                {item.evidence && <span className="ml-1 font-mono text-2xs text-muted-foreground">{item.evidence.file}{item.evidence.line ? `:${item.evidence.line}` : ""}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FoundStep({ state, filter, setFilter, focus }: { state: ProjectSetupState; filter: Filter; setFilter: (f: Filter) => void; focus?: string }) {
  const report = state.report!;
  const [shown, setShown] = useState(PAGE);
  const projects = report.projects
    .filter((project) => !focus || project.toolchains.includes(focus as never))
    .filter((project) => filter === "all" || (filter === "inplay" ? project.inPlay : project.needsAttention))
    .sort((a, b) => Number(b.inPlay) - Number(a.inPlay) || Number(b.needsAttention) - Number(a.needsAttention) || a.display.localeCompare(b.display));
  const attention = report.projects.filter((project) => project.needsAttention).length;
  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground">
        {report.projects.length === 0
          ? "No projects found: no package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, .csproj or similar in this workspace."
          : `${report.projects.length} project${report.projects.length === 1 ? "" : "s"} found${report.truncated ? " (the scan stopped at its limit; open a narrower folder for the rest)" : ""}. ${attention === 0 ? "All of them look ready." : `${attention} need${attention === 1 ? "s" : ""} attention.`}`}
      </p>
      {focus && <Note>Showing projects that use {focus}.</Note>}
      {report.projects.length > 0 && (
        <Segmented<Filter>
          options={[{ id: "attention", label: `Needs attention (${attention})` }, { id: "inplay", label: "In use" }, { id: "all", label: "All" }]}
          value={filter}
          onChange={(next) => { setFilter(next); setShown(PAGE); }}
        />
      )}
      <ul className="space-y-1">
        {projects.slice(0, shown).map((project) => <ProjectRow key={project.dir} project={project} />)}
      </ul>
      {projects.length === 0 && report.projects.length > 0 && <Note>Nothing here with this filter.</Note>}
      {projects.length > shown && <Button size="xs" variant="outline" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, projects.length - shown)} more</Button>}
    </div>
  );
}

function MachineStep({ state, focus }: { state: ProjectSetupState; focus?: string }) {
  const report = state.report!;
  const machine = state.machine;
  const toolchains = report.toolchains.filter((overview) => !focus || overview.toolchain === focus);
  return (
    <div className="space-y-2">
      {toolchains.length === 0 && <Note>None of the projects here need a toolchain this guide covers.</Note>}
      {toolchains.map((overview) => (
        <section key={overview.toolchain} className="rounded-md border border-border bg-white/[0.02] px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <StatusIcon kind={overview.unsatisfied.length === 0 ? "ok" : overview.installs.length === 0 ? "fail" : "warn"} />
            <span className="text-sm font-semibold text-foreground">{overview.toolchain}</span>
            {overview.latest && <span className="ml-auto text-2xs text-muted-foreground">latest line {overview.latest}</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{overview.summary}</p>
          <ul className="mt-1 space-y-0.5">
            {overview.installs.length === 0 && <li className="text-xs text-foreground/80">Not installed.</li>}
            {overview.installs.map((install) => (
              <li key={install.path} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                <span className="font-medium text-foreground">{install.version ?? "unknown version"}</span>
                <span className="text-muted-foreground">{install.source}</span>
                <span className="text-foreground/80">satisfies {install.satisfiesCount} of {overview.projectCount}</span>
                {install.endOfLife && <span style={{ color: "var(--s-warn)" }}>end of life</span>}
                <span className="w-full truncate font-mono text-2xs text-muted-foreground" title={install.path}>{install.path}</span>
              </li>
            ))}
          </ul>
          {overview.unsatisfied.length > 0 && <p className="mt-1 text-xs text-foreground/80">Not covered: {overview.unsatisfied.slice(0, 6).join(", ")}{overview.unsatisfied.length > 6 ? ` and ${overview.unsatisfied.length - 6} more` : ""}</p>}
        </section>
      ))}
      {machine && (
        <p className="text-xs text-muted-foreground">
          Package managers found: {machine.managers.length > 0 ? machine.managers.join(", ") : "none"}. Checked {new Date(machine.probedAt).toLocaleTimeString()}.
        </p>
      )}
    </div>
  );
}

const WHAT_IT_DOES: Record<Recommendation["intent"]["kind"], string> = {
  system: "Installs with your platform's package manager (winget, Homebrew or apt/dnf). It is available to every project and every terminal. Remove it later with the same package manager.",
  project_toolchain: "Puts a private copy inside the project (.toolchains or .dotnet), from the official download with its checksum checked. Nothing outside the project changes; delete the folder to undo. The folder is added to .gitignore.",
  venv: "Creates a .venv folder in the project, its own place for packages. The agent's python, pytest and pip in this project use it. Delete the folder to undo; it is added to .gitignore.",
  deps: "Runs the project's own install command in the project folder. It downloads the packages its lockfile lists.",
  tool: "Installs a helper tool another step needs.",
  extension: "Installs a VS Code extension when you confirm the plan. Uninstall it from the Extensions view.",
  workspace_folders: "Adds the projects as workspace folders, so VS Code gives each its own interpreter. Your window becomes a multi-root workspace; remove folders from the Explorer to undo.",
};

function RecommendationRow({ recommendation, checked, onToggle, required }: { recommendation: Recommendation; checked: boolean; onToggle: () => void; required: boolean }) {
  const [open, setOpen] = useState(false);
  const id = `setup-rec-${recommendation.id}`;
  return (
    <li className="rounded-md border border-border bg-white/[0.02] px-2 py-1.5">
      <div className="flex items-start gap-2">
        {recommendation.blocked
          ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--s-warn)" }} aria-hidden />
          : <input id={id} type="checkbox" className="mt-0.5" checked={checked || required} disabled={required} onChange={onToggle} />}
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block text-sm font-medium text-foreground">{recommendation.title}</label>
          <p className="text-xs text-foreground/80">{recommendation.blocked ?? recommendation.why}</p>
          {required && !checked && <p className="text-2xs text-muted-foreground">Included because another step you chose needs it.</p>}
          <button type="button" className="mt-0.5 text-2xs text-primary hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "What this does"}
          </button>
          {open && <p className="mt-0.5 text-xs text-muted-foreground">{WHAT_IT_DOES[recommendation.intent.kind]}</p>}
        </div>
      </div>
    </li>
  );
}

function requiredBy(recommendations: readonly Recommendation[], selected: ReadonlySet<string>): Set<string> {
  const byId = new Map(recommendations.map((recommendation) => [recommendation.id, recommendation]));
  const required = new Set<string>();
  const visit = (id: string): void => {
    for (const need of byId.get(id)?.needs ?? []) {
      if (required.has(need)) continue;
      required.add(need);
      visit(need);
    }
  };
  for (const id of selected) visit(id);
  return required;
}

function RunStepRow({ step, finished }: { step: SetupRunStep; finished: boolean }) {
  const status = step.exitCode === undefined ? (finished ? "pending" : "pending") : step.skipped || step.exitCode === -1 ? "pending" : step.exitCode === 0 ? "ok" : "fail";
  const label = step.exitCode === undefined ? (finished ? "not run" : "waiting") : step.skipped || step.exitCode === -1 ? "skipped (an earlier step failed)" : step.exitCode === 0 ? "done" : "failed";
  function askAgent(): void {
    actions.injectContext(
      `This toolchain setup step failed:\n${step.project ? `Project: ${step.project}\n` : ""}Step: ${step.title}\nCommands:\n${step.commands.map((command) => `  ${command}`).join("\n")}\nIts output is in the "Blacksite: Toolchain setup" terminal. Help me work out why it failed and what to do instead.`,
      `setup failure: ${step.title}`,
    );
    actions.setView("chat");
  }
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <StatusIcon kind={status} />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">{step.project ? <span className="font-mono">{step.project}: </span> : null}{step.title}</span>
        <span className="ml-1 text-muted-foreground">— {label}</span>
        {status === "fail" && <button type="button" className="ml-2 text-primary hover:underline" onClick={askAgent}>Ask the agent about this failure</button>}
      </div>
    </li>
  );
}

function ReviewStep({ state, onStart, selectedCount }: { state: ProjectSetupState; onStart: () => void; selectedCount: number }) {
  const preview = state.preview;
  if (!preview || state.status === "planning") {
    return <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Building the plan…</p>;
  }
  const phases: Array<[SetupRunStep["phase"], string]> = [["prerequisite", "First"], ["system", "For this machine"], ["project", "Inside projects"], ["dependencies", "Dependencies"]];
  let number = 0;
  return (
    <div className="space-y-2">
      {selectedCount === 0 && <Note>Nothing is selected. Go back and tick what you want done.</Note>}
      {phases.map(([phase, heading]) => {
        const steps = preview.steps.filter((step) => step.phase === phase);
        if (steps.length === 0) return null;
        return (
          <section key={phase}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h4>
            <ol className="mt-1 space-y-1.5">
              {steps.map((step) => {
                number += 1;
                return (
                  <li key={step.id} className="rounded-md border border-border bg-white/[0.02] px-2 py-1.5 text-xs">
                    <div className="font-medium text-foreground">{number}. {step.project ? <span className="font-mono">{step.project}: </span> : null}{step.title}</div>
                    <div className="text-muted-foreground">Where: {step.target}</div>
                    {step.elevation !== "none" && <div style={{ color: "var(--s-warn)" }}>{step.elevation === "admin" ? "Windows asks for administrator permission." : "Asks for your password (sudo)."}</div>}
                    {step.commands.map((command, index) => <pre key={index} className="mt-0.5 whitespace-pre-wrap break-all font-mono text-2xs text-foreground/90">$ {command}</pre>)}
                    <div className="mt-0.5 text-muted-foreground">Undo: {step.undo}</div>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      {preview.extensions.length > 0 && <p className="text-xs text-foreground/90">Editor extensions installed when you start: {preview.extensions.join(", ")}.</p>}
      {preview.workspaceFolders.length > 0 && <p className="text-xs text-foreground/90">Added as workspace folders at the end: {preview.workspaceFolders.length}.</p>}
      {preview.added.map((line) => <Note key={line}>Also included, because a step you chose needs it: {line}.</Note>)}
      {preview.problems.map((line) => <p key={line} className="text-xs" style={{ color: "var(--s-warn)" }}>{line}</p>)}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={onStart} disabled={preview.steps.length === 0 && preview.extensions.length === 0 && preview.workspaceFolders.length === 0}>
          <Terminal className="size-3.5" /> {preview.steps.length > 0 ? "Open the setup terminal" : "Apply"}
        </Button>
        {preview.steps.length > 0 && <span className="text-xs text-muted-foreground">The terminal shows this plan again. Nothing is installed until you type <strong>Y</strong> there.</span>}
      </div>
    </div>
  );
}

function DoneStep({ state }: { state: ProjectSetupState }) {
  const run = state.run;
  if (!run) return <Note>Nothing has run yet.</Note>;
  const now = new Set((state.report?.projects ?? []).filter((project) => project.needsAttention).map((project) => project.display));
  const fixed = run.attentionBefore.filter((display) => !now.has(display));
  const failed = run.steps.filter((step) => step.exitCode !== undefined && step.exitCode > 0).length;
  return (
    <div className="space-y-2">
      {!run.finished && (
        <p className="flex items-center gap-1.5 text-sm text-foreground"><Loader2 className="size-3.5 animate-spin" /> Waiting for the terminal. Check the plan there and type Y to start.</p>
      )}
      {run.finished && run.declined && <p className="text-sm text-foreground">Cancelled in the terminal. Nothing was changed.</p>}
      {run.finished && !run.declined && run.steps.length > 0 && (
        <p className="text-sm text-foreground">{failed === 0 ? "Every step finished." : `${failed} step${failed === 1 ? "" : "s"} did not finish; the others did.`} The agent sees the updated toolchains from its next step.</p>
      )}
      <ul className="space-y-1">{run.steps.map((step) => <RunStepRow key={step.id} step={step} finished={run.finished} />)}</ul>
      {run.extensions.map((extension) => (
        <p key={extension.id} className="flex items-center gap-1.5 text-xs"><StatusIcon kind={extension.ok ? "ok" : "fail"} /> Extension {extension.id}{extension.ok ? " installed" : `: ${extension.error ?? "failed"}`}</p>
      ))}
      {run.problems.map((line) => <p key={line} className="text-xs" style={{ color: "var(--s-warn)" }}>{line}</p>)}
      {run.finished && run.attentionBefore.length > 0 && (
        <p className="text-xs text-foreground/90">Before: {run.attentionBefore.length} project{run.attentionBefore.length === 1 ? "" : "s"} needed attention. Now: {now.size}.{fixed.length > 0 ? ` Ready now: ${fixed.slice(0, 5).join(", ")}${fixed.length > 5 ? "…" : ""}.` : ""}</p>
      )}
      {run.finished && <Button size="xs" variant="outline" onClick={() => actions.dismissProjectSetupRun()}>Start over</Button>}
    </div>
  );
}

export function ProjectSetupPanel() {
  const store = useStore();
  const state = store.projectSetup;
  const target = store.settingsTarget;
  const [step, setStep] = useState<StepId>(0);
  const [filter, setFilter] = useState<Filter>("attention");
  const [focus, setFocus] = useState<string | undefined>(target?.focus?.toolchain);
  const report = state?.report;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => { actions.scanProjectSetup({ ifIdle: true }); }, []);
  // A request from outside (the missing-tool offer) focuses one toolchain.
  const targetNonce = target?.nonce;
  const targetToolchain = target?.focus?.toolchain;
  useEffect(() => {
    if (targetNonce === undefined) return;
    setFocus(targetToolchain);
    setStep(0);
  }, [targetNonce, targetToolchain]);
  // A new report brings fresh recommendations: take its pre-selection.
  useEffect(() => {
    if (!report) return;
    setSelected(new Set(report.recommendations.filter((recommendation) => recommendation.selected && !recommendation.blocked).map((recommendation) => recommendation.id)));
  }, [report]);
  // A run in progress or just finished owns the panel.
  const hasRun = !!state?.run;
  useEffect(() => { if (hasRun) setStep(4); }, [hasRun]);

  const recommendations = useMemo(() => (report?.recommendations ?? []).filter((recommendation) => !focus || !recommendation.toolchain || recommendation.toolchain === focus), [report, focus]);
  const required = useMemo(() => requiredBy(report?.recommendations ?? [], selected), [report, selected]);
  const chosen = [...selected].filter((id) => recommendations.some((recommendation) => recommendation.id === id));

  if (!state || state.status === "idle" || (state.status === "scanning" && !report)) {
    return <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Looking at your projects and what this machine has installed…</p>;
  }
  if (state.status === "error" && !report) {
    return (
      <div className="space-y-2">
        <p className="text-sm" style={{ color: "var(--s-warn)" }}>The scan failed: {state.error}</p>
        <Button size="xs" variant="outline" onClick={() => actions.scanProjectSetup()}>Try again</Button>
      </div>
    );
  }
  if (!report) return null;

  const canReach = (id: StepId): boolean => id === 4 ? !!state.run : !state.run || state.run.finished;
  function goReview(): void {
    actions.previewProjectSetup(chosen);
    setStep(3);
  }

  return (
    <div className="space-y-3" data-setting="project-setup">
      <Note>
        Checks what each project in this workspace needs, compares it with what is installed, and suggests the least work to get them running.
        Installs run in a terminal you can watch, and only after you type Y.
      </Note>
      <div className="flex flex-wrap items-center gap-2">
        <Stepper step={step} onStep={(next) => (next === 3 ? goReview() : setStep(next))} canReach={canReach} />
        <Button size="xs" variant="ghost" className="ml-auto" title="Scan again" disabled={state.status === "scanning" || state.status === "running"} onClick={() => actions.scanProjectSetup({ focus: focus ? { toolchain: focus } : undefined })}>
          <RefreshCw className={cn("size-3", state.status === "scanning" && "animate-spin")} /> Rescan
        </Button>
      </div>
      {focus && (
        <p className="text-xs text-muted-foreground">Focused on {focus}. <button type="button" className="text-primary hover:underline" onClick={() => setFocus(undefined)}>Show everything</button></p>
      )}
      {state.error && <p className="text-xs" style={{ color: "var(--s-warn)" }}>{state.error}</p>}

      {step === 0 && <FoundStep state={state} filter={filter} setFilter={setFilter} focus={focus} />}
      {step === 1 && <MachineStep state={state} focus={focus} />}
      {step === 2 && (
        <div className="space-y-2">
          {recommendations.length === 0
            ? <p className="text-sm text-foreground">Nothing to do: everything the projects need is installed.</p>
            : <p className="text-xs text-muted-foreground">Reusing what is installed comes first. Per-project steps are pre-selected only for the projects you have open.</p>}
          <ul className="space-y-1">
            {recommendations.map((recommendation) => (
              <RecommendationRow
                key={recommendation.id}
                recommendation={recommendation}
                checked={selected.has(recommendation.id)}
                required={required.has(recommendation.id) && !selected.has(recommendation.id)}
                onToggle={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(recommendation.id)) next.delete(recommendation.id);
                  else next.add(recommendation.id);
                  return next;
                })}
              />
            ))}
          </ul>
        </div>
      )}
      {step === 3 && <ReviewStep state={state} selectedCount={chosen.length} onStart={() => { actions.applyProjectSetup(state.preview?.ids ?? chosen); setStep(4); }} />}
      {step === 4 && <DoneStep state={state} />}

      {step < 3 && (
        <div className="flex items-center gap-2 border-t border-border pt-2">
          {step > 0 && <Button size="xs" variant="outline" onClick={() => setStep((step - 1) as StepId)}>Back</Button>}
          <Button size="xs" className="ml-auto" onClick={() => (step === 2 ? goReview() : setStep((step + 1) as StepId))} disabled={step === 2 && chosen.length === 0}>
            {step === 2 ? `Review ${chosen.length} step${chosen.length === 1 ? "" : "s"}` : "Next"}
          </Button>
        </div>
      )}
    </div>
  );
}
