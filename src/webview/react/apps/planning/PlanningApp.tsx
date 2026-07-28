import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/PanelHeader";
import { StatusBadge } from "@/components/ui/status-badge";
import { Markdown } from "@/components/ui/markdown";
import { TerritoryChips } from "@/components/ui/territory-chips";
import { post, onMessage } from "@/lib/bridge";

/** Plan documents run to 50,000 characters. The panel expansion is a preview; the "Edit"
 *  button opens the real file in an editor tab, which is where a document that long is
 *  meant to be read. */
const DOC_PREVIEW_CHARS = 8_000;

/** Plan text is model-authored Markdown — every multi-line field is normalized with the
 *  store's `cleanParagraph`, which preserves newlines precisely so structure survives. In a
 *  side panel it renders compact. File links open in the editor; the Plans panel has no
 *  lightbox, so images fall back to the renderer's placeholder chip. */
function PlanMarkdown(
  { raw, className, variant = "block" }: { raw: string; className?: string; variant?: "block" | "inline" },
) {
  return (
    <Markdown
      raw={raw}
      variant={variant}
      density="compact"
      className={className}
      onOpenFile={(path) => post({ type: "open_phase_file", path })}
    />
  );
}

interface Step {
  id: string; title?: string; label?: string; status: string; detail?: string; result?: string;
  acceptanceCriteria?: string; maxIterations?: number; notes?: string[];
}
interface Block { id: string; kind: string; label?: string; body: string; }
interface Doc { id: string; kind: string; title: string; source: "agent" | "user"; attachmentFilename?: string; createdAt: string; updatedAt: string; byteSize: number; }
interface Phase {
  id: string; title: string; objective?: string; status: string; steps: Step[];
  rationale?: string; risks?: string; dependsOn?: string[]; acceptanceCriteria?: string[]; complexity?: string;
  /** Workspace-relative files this phase expects to touch — its Codebase Map territory. */
  files?: string[];
  blocks?: Block[]; docs?: Doc[]; notes?: string[];
}
interface Plan {
  id: string; title: string; summary?: string; status: string; activePhaseId?: string; phases: Phase[];
  blocks?: Block[]; docs?: Doc[]; notes?: string[]; agentCanArchive?: boolean; executionApproved?: boolean;
}
interface TodoRun { id: string; name: string; completedAt?: string; steps: Step[]; planId?: string; phaseId?: string; }
interface PlanningDoc { plans: Plan[]; todoRuns: TodoRun[]; }
interface Counts { activePlans: number; activeTodos: number; totalPlans: number; totalTodos: number; }
type DocContentState = { status: "loading" | "loaded" | "error"; body?: string };

const EMPTY: PlanningDoc = { plans: [], todoRuns: [] };

function Empty({ children }: { children: string }) {
  return <div className="planning-empty fade-in chat-surface border-dashed p-4 text-sm leading-relaxed text-muted-foreground">{children}</div>;
}

function NoteList({ label = "Activity", notes }: { label?: string; notes?: string[] }) {
  if (!notes?.length) return null;
  return (
    <div className="planning-notes">
      <div className="planning-notes-label">{label}</div>
      <ul>
        {notes.map((note, index) => <li key={`${index}-${note}`}><PlanMarkdown raw={note} /></li>)}
      </ul>
    </div>
  );
}

function StepRow(
  { idLabel, primary, detail, acceptanceCriteria, status, maxIterations, notes }: {
    idLabel: string; primary: string; detail?: string; acceptanceCriteria?: string; status: string; maxIterations?: number; notes?: string[];
  },
) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground"><span className="font-mono text-muted-foreground">{idLabel}</span> {primary}</div>
        {detail && <PlanMarkdown raw={detail} className="mt-0.5 text-xs text-muted-foreground" />}
        {acceptanceCriteria && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            <span className="text-xs uppercase tracking-wide opacity-70">Done when:</span>
            <PlanMarkdown raw={acceptanceCriteria} />
          </div>
        )}
        <NoteList label="Latest updates" notes={notes} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!!maxIterations && (
          <span className="rounded-full bg-white/10 px-1.5 py-px font-mono text-xs text-muted-foreground" title={`Worth iterating on — up to ${maxIterations} self-review passes`}>
            ↻ ×{maxIterations}
          </span>
        )}
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

function titleCaseKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Modular plan/phase content blocks (findings, options considered, deliverables, ...) — see
 *  PlanBlock in planning-store.ts. Renders nothing when there are none. */
function BlockList({ blocks }: { blocks?: Block[] }) {
  if (!blocks?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block) => (
        <div key={block.id} className="rounded-md bg-white/[0.03] px-2 py-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{block.label || titleCaseKind(block.kind)}</div>
          <PlanMarkdown raw={block.body} className="mt-0.5 text-sm text-foreground" />
        </div>
      ))}
    </div>
  );
}

/** A button that arms on first click ("Remove" → "Confirm?") and only fires on the second,
 *  auto-disarming after a few seconds so it never gets stuck in a scary state. Shared by
 *  doc removal and permanent plan deletion — anything destructive enough to want a guard
 *  without a heavier native confirm() dialog (unreliable inside some webview hosts). */
function ConfirmButton(
  { label, confirmLabel, onConfirm, variant = "ghost" }: { label: string; confirmLabel: string; onConfirm: () => void; variant?: "ghost" | "outline" },
) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="xs"
      variant={variant}
      onClick={() => { if (armed) { onConfirm(); setArmed(false); } else setArmed(true); }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/**
 * Documentation attached to a plan or one phase — research writeups, decisions, specs, notes,
 * or a copied file reference (see PlanDocMeta in planning-store.ts). Persists in the project
 * under .blacksite/plans/ until removed here, independent of the plan's own lifecycle.
 * Markdown docs expand inline (plain text — full rendering lives in the real editor via
 * "Edit", which opens the underlying .md file); file attachments always just open/reveal.
 */
function DocRow(
  { planId, doc, content, onRequestContent }: {
    planId: string; doc: Doc; content?: DocContentState; onRequestContent: (planId: string, docId: string) => void;
  },
) {
  const [expanded, setExpanded] = useState(false);
  const isFile = !!doc.attachmentFilename;

  function toggle(): void {
    if (isFile) { post({ type: "open_plan_doc", planId, docId: doc.id }); return; }
    if (!expanded && content?.status !== "loaded") onRequestContent(planId, doc.id);
    setExpanded((v) => !v);
  }

  return (
    <div className="rounded-md bg-white/[0.03] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={toggle} className="chat-interactive flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px font-mono text-2xs uppercase tracking-wide text-muted-foreground">{titleCaseKind(doc.kind)}</span>
          <span className="truncate text-sm text-foreground">{doc.title}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">{formatBytes(doc.byteSize)}</span>
          {doc.source === "agent" && <span className="shrink-0 text-2xs text-muted-foreground opacity-60">· agent</span>}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => post({ type: "open_plan_doc", planId, docId: doc.id })}>
            {isFile ? "Open" : "Edit"}
          </Button>
          <ConfirmButton label="Remove" confirmLabel="Confirm?" onConfirm={() => post({ type: "delete_plan_doc", planId, docId: doc.id })} />
        </div>
      </div>
      {expanded && !isFile && (
        <div className="mt-1.5 max-h-[320px] overflow-y-auto rounded-md border border-border bg-black/20 p-2 text-xs leading-snug text-muted-foreground">
          {(!content || content.status === "loading") && <span>Loading…</span>}
          {content?.status === "error" && <span className="text-[color:var(--s-err)]">Could not load this doc.</span>}
          {content?.status === "loaded" && (
            content.body
              ? (
                <Markdown
                  raw={content.body}
                  density="compact"
                  previewChars={DOC_PREVIEW_CHARS}
                  onOpenFile={(path) => post({ type: "open_phase_file", path })}
                />
              )
              : <span>(Empty.)</span>
          )}
        </div>
      )}
    </div>
  );
}

function DocList(
  { planId, docs, content, onRequestContent }: {
    planId: string; docs?: Doc[]; content: Record<string, DocContentState>; onRequestContent: (planId: string, docId: string) => void;
  },
) {
  if (!docs?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {docs.map((doc) => (
        <DocRow key={doc.id} planId={planId} doc={doc} content={content[doc.id]} onRequestContent={onRequestContent} />
      ))}
    </div>
  );
}

/** "＋ New note" / "＋ Add reference" — the user's own direct path to attaching documentation,
 *  independent of asking the agent to via plan_doc_write. New note opens the fresh (nearly
 *  empty) file straight in the editor; Add reference hands off to a native file picker. */
function DocAddRow({ planId, phaseId }: { planId: string; phaseId?: string }) {
  return (
    <div className="flex gap-1.5">
      <Button size="xs" variant="outline" onClick={() => post({ type: "new_plan_doc", planId, phaseId, kind: "notes", title: "New note" })}>
        ＋ New note
      </Button>
      <Button size="xs" variant="outline" onClick={() => post({ type: "add_plan_doc_file", planId, phaseId })}>
        ＋ Add reference
      </Button>
    </div>
  );
}

/** Phase-level extras (rationale / risks / dependencies / acceptance criteria / complexity) —
 *  every field here is optional, so this renders nothing extra for plans that don't use them. */
function PhaseExtras({ phase }: { phase: Phase }) {
  const hasAny = phase.rationale || phase.risks || phase.complexity
    || phase.dependsOn?.length || phase.acceptanceCriteria?.length || phase.files?.length;
  if (!hasAny) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-1.5">
      {phase.rationale && (
        <div className="text-sm text-muted-foreground">
          <span className="opacity-70">Why:</span>
          <PlanMarkdown raw={phase.rationale} />
        </div>
      )}
      {(phase.risks || phase.complexity) && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          {phase.complexity && <StatusBadge status={phase.complexity} />}
          {phase.risks && (
            <span className="min-w-0 flex-1">⚠ <PlanMarkdown raw={phase.risks} variant="inline" /></span>
          )}
        </div>
      )}
      {!!phase.dependsOn?.length && (
        <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <span className="opacity-70">Depends on:</span>
          {phase.dependsOn.map((id) => <span key={id} className="rounded-full bg-white/10 px-1.5 py-px font-mono">{id}</span>)}
        </div>
      )}
      {!!phase.files?.length && (
        <TerritoryChips
          files={phase.files}
          label="Map territory:"
          onOpenFile={(path) => post({ type: "open_phase_file", path })}
          onRevealOnMap={(path) => post({ type: "show_phase_file_on_map", path })}
        />
      )}
      {!!phase.acceptanceCriteria?.length && (
        <ul className="list-disc pl-4 text-xs text-muted-foreground">
          {/* Phase-level criteria are normalized with the store's cleanText (one collapsed
              line each), so they get the inline renderer — no block structure to honour. */}
          {phase.acceptanceCriteria.map((line, i) => <li key={i}><PlanMarkdown raw={line} variant="inline" /></li>)}
        </ul>
      )}
    </div>
  );
}

function todoStatus(run: TodoRun): string {
  if (run.completedAt) return run.steps.some((s) => s.status === "failed") ? "failed" : "completed";
  return run.steps.some((s) => s.status === "running") ? "running" : "pending";
}

function isComplete(status: string | undefined): boolean {
  return status === "done" || status === "completed";
}

function isBlocked(status: string | undefined): boolean {
  return status === "blocked" || status === "failed";
}

function isTerminalPlan(status: string | undefined): boolean {
  return status === "completed" || status === "cancelled" || status === "archived";
}

function stepProgress(steps: Step[]): { done: number; blocked: number; total: number } {
  return {
    done: steps.filter((step) => isComplete(step.status)).length,
    blocked: steps.filter((step) => isBlocked(step.status)).length,
    total: steps.length,
  };
}

function findCurrentStep(phase: Phase): Step | undefined {
  return phase.steps.find((step) => step.status === "in_progress" || step.status === "running")
    ?? phase.steps.find((step) => !isComplete(step.status) && !isBlocked(step.status))
    ?? phase.steps.find((step) => isBlocked(step.status));
}

function findActivePhase(plan: Plan): Phase | undefined {
  return plan.phases.find((phase) => phase.id === plan.activePhaseId)
    ?? plan.phases.find((phase) => phase.status === "active" || phase.status === "in_progress" || findCurrentStep(phase));
}

/** User controls to hold / resume / cancel / reopen / archive / permanently delete a plan.
 *  Archiving (below) is a status change, not a deletion — it just freezes the plan out of the
 *  active view. Everything the plan and its docs contain stays on disk until "Delete" is
 *  explicitly confirmed. */
function PlanControls({ status, planId }: { status: string; planId: string }) {
  const setStatus = (s: string) => post({ type: "set_plan_status", planId, status: s });
  const terminal = status === "completed" || status === "cancelled" || status === "archived";
  return (
    <div className="planning-plan-actions flex shrink-0 flex-wrap justify-end gap-1">
      {status === "on_hold" ? (
        <Button size="xs" variant="outline" onClick={() => setStatus("active")}>Resume</Button>
      ) : !terminal ? (
        <Button size="xs" variant="outline" onClick={() => setStatus("on_hold")}>Hold</Button>
      ) : null}
      {!terminal && (
        <Button size="xs" variant="ghost" onClick={() => setStatus("cancelled")}>Cancel</Button>
      )}
      {terminal && (
        <>
          <Button size="xs" variant="ghost" onClick={() => setStatus("active")}>Reopen</Button>
          {status !== "archived" && (
            <Button size="xs" variant="ghost" onClick={() => setStatus("archived")}>Archive</Button>
          )}
          <ConfirmButton label="Delete" confirmLabel="Delete for good?" onConfirm={() => post({ type: "delete_plan", planId })} />
        </>
      )}
    </div>
  );
}

/** Toggle for whether the agent may archive THIS plan itself (agentCanArchive) — the agent
 *  can only ever set this true because the user said so in conversation; this switch is the
 *  user's own always-available way to grant or take that back without going through the agent. */
function AgentArchiveToggle({ planId, allowed }: { planId: string; allowed: boolean }) {
  return (
    <button
      type="button"
      title={allowed
        ? "The agent may archive this plan itself once it's done. Click to take that back."
        : "Archiving is a manual, user-only action for this plan. Click to let the agent archive it itself once finished."}
      onClick={() => post({ type: "set_plan_archive_permission", planId, allow: !allowed })}
      className="chat-interactive inline-flex items-center gap-1 rounded-full border border-border bg-white/[0.03] px-1.5 py-px text-2xs text-muted-foreground hover:border-primary/40"
    >
      <span className={`size-1.5 rounded-full ${allowed ? "bg-[color:var(--s-ok)]" : "bg-white/20"}`} />
      Agent may archive
    </button>
  );
}

/**
 * The prominent execution-approval call-to-action. Rendered only while a plan is still
 * awaiting the user's go-ahead (and isn't terminal): until it's approved the agent keeps
 * planning, researching, writing docs, and asking questions, but plan_update won't let it
 * advance any step/phase. Approving lifts the gate. Once approved, this disappears and the
 * compact ExecutionToggle chip in the header carries the pause/resume control instead.
 */
function ExecutionGate({ planId, approved, status }: { planId: string; approved: boolean; status: string }) {
  const terminal = status === "completed" || status === "cancelled" || status === "archived";
  if (approved || terminal) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/[0.08] p-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">Awaiting your go-ahead</div>
        <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
          The agent will keep planning, researching, and asking questions — but won&apos;t start implementing until you approve.
        </div>
      </div>
      <Button
        size="sm"
        className="shrink-0"
        onClick={() => post({ type: "set_plan_execution_approval", planId, approved: true })}
      >
        Approve execution
      </Button>
    </div>
  );
}

/** Compact header chip mirroring AgentArchiveToggle: the always-available, low-profile
 *  execution approve/pause control. The big ExecutionGate banner is the attention-grabbing
 *  CTA while approval is pending; this chip is how the user flips it back and forth after. */
function ExecutionToggle({ planId, approved }: { planId: string; approved: boolean }) {
  return (
    <button
      type="button"
      title={approved
        ? "Execution approved — the agent may implement this plan. Click to pause execution."
        : "Execution is paused — the agent won't implement this plan yet. Click to approve."}
      onClick={() => post({ type: "set_plan_execution_approval", planId, approved: !approved })}
      className="chat-interactive inline-flex items-center gap-1 rounded-full border border-border bg-white/[0.03] px-1.5 py-px text-2xs text-muted-foreground hover:border-primary/40"
    >
      <span className={`size-1.5 rounded-full ${approved ? "bg-[color:var(--s-ok)]" : "bg-[color:var(--s-warn)]"}`} />
      {approved ? "Execution on" : "Execution paused"}
    </button>
  );
}

function ProgressMeter({ value, total, tone = "primary" }: { value: number; total: number; tone?: "primary" | "warn" | "error" }) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  const color = tone === "error" ? "var(--s-err)" : tone === "warn" ? "var(--s-warn)" : "var(--primary)";
  return (
    <div className="flex items-center gap-2" aria-label={total > 0 ? `${value} of ${total} steps complete` : "No steps"}>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${percent}%`, background: color }} />
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{total > 0 ? `${value}/${total}` : "No steps"}</span>
    </div>
  );
}

function PhaseCard(
  { planId, phase, index, active, docContent, onRequestDocContent }: {
    planId: string; phase: Phase; index: number; active: boolean;
    docContent: Record<string, DocContentState>; onRequestDocContent: (planId: string, docId: string) => void;
  },
) {
  const [open, setOpen] = useState(active || phase.status === "in_progress");
  useEffect(() => {
    if (active || phase.status === "in_progress") setOpen(true);
  }, [active, phase.status]);
  const progress = stepProgress(phase.steps);
  const current = findCurrentStep(phase);
  const tone = progress.blocked > 0 ? "error" : phase.status === "on_hold" ? "warn" : "primary";
  const bodyId = `plan-phase-${phase.id}`;

  return (
    <section className={`plan-phase ${active ? "is-active" : ""} ${progress.blocked > 0 ? "has-failure" : ""}`}>
      <button
        type="button"
        className="plan-phase-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="plan-phase-index">{index + 1}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-base font-semibold text-foreground">{phase.title || phase.id}</span>
            {active && <span className="plan-phase-current">Current</span>}
          </span>
          <span className="line-clamp-1 text-sm text-muted-foreground">{phase.objective || "No objective recorded."}</span>
        </span>
        <StatusBadge status={phase.status || "pending"} />
        <span className={`plan-phase-chevron ${open ? "is-open" : ""}`} aria-hidden="true">⌄</span>
      </button>
      <div className="px-2.5 pb-2">
        <ProgressMeter value={progress.done} total={progress.total} tone={tone} />
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {current ? `Next: ${current.id} ${current.title || current.label || "Untitled step"}` : "No remaining steps."}
        </div>
      </div>
      {open && (
        <div id={bodyId} className="plan-phase-body">
          <PhaseExtras phase={phase} />
          <BlockList blocks={phase.blocks} />
          <NoteList notes={phase.notes} />
          <DocList planId={planId} docs={phase.docs} content={docContent} onRequestContent={onRequestDocContent} />
          <div className="flex flex-col gap-1.5">
            {phase.steps.map((step) => (
              <StepRow
                key={step.id}
                idLabel={step.id}
                primary={step.title || step.label || "Untitled step"}
                detail={step.detail || step.result}
                acceptanceCriteria={step.acceptanceCriteria}
                status={step.status || "pending"}
                maxIterations={step.maxIterations}
                notes={step.notes}
              />
            ))}
          </div>
          <DocAddRow planId={planId} phaseId={phase.id} />
        </div>
      )}
    </section>
  );
}

function PlanCard(
  { plan, docContent, onRequestDocContent }: {
    plan: Plan; docContent: Record<string, DocContentState>; onRequestDocContent: (planId: string, docId: string) => void;
  },
) {
  const phases = plan.phases;
  const steps = phases.flatMap((phase) => phase.steps);
  const progress = stepProgress(steps);
  const activePhase = findActivePhase(plan);
  const current = activePhase ? findCurrentStep(activePhase) : undefined;
  const tone = progress.blocked > 0 ? "error" : plan.status === "on_hold" ? "warn" : "primary";
  // Grandfathered/older plans arrive without the field; treat only an explicit false as unapproved.
  const approved = plan.executionApproved !== false;
  const terminal = isTerminalPlan(plan.status);

  return (
    <article className={`plan-card turn-in overflow-hidden rounded-xl border border-border bg-white/[0.03] ${!approved && !terminal ? "is-awaiting-approval" : ""} ${plan.status === "on_hold" ? "is-on-hold" : ""}`}>
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-lg font-semibold text-foreground">{plan.title || plan.id}</span>
            <StatusBadge status={plan.status || "active"} />
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-snug text-muted-foreground">
            {/* A clamped teaser: the inline renderer keeps emphasis and code spans without
                introducing block elements that line-clamp cannot measure. */}
            {plan.summary ? <PlanMarkdown raw={plan.summary} variant="inline" /> : "No summary provided."}
          </div>
          <div className="mt-2">
            <ProgressMeter value={progress.done} total={progress.total} tone={tone} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{plan.id}</span>
            <span>{phases.length} phase{phases.length === 1 ? "" : "s"}</span>
            {progress.blocked > 0 && <span className="text-[color:var(--s-err)]">{progress.blocked} blocked</span>}
            {current && <span className="text-foreground">Now: {current.id}</span>}
            {!terminal && <ExecutionToggle planId={plan.id} approved={approved} />}
            <AgentArchiveToggle planId={plan.id} allowed={!!plan.agentCanArchive} />
          </div>
        </div>
        <PlanControls status={plan.status} planId={plan.id} />
      </div>
      {!approved && !terminal && (
        <div className="border-t border-border/70 px-2.5 py-2.5">
          <ExecutionGate planId={plan.id} approved={approved} status={plan.status} />
        </div>
      )}
      <div className="flex flex-col gap-1.5 border-t border-border/70 px-2.5 py-2.5">
        <BlockList blocks={plan.blocks} />
        <NoteList notes={plan.notes} />
        <DocList planId={plan.id} docs={plan.docs} content={docContent} onRequestContent={onRequestDocContent} />
        <DocAddRow planId={plan.id} />
      </div>
      <div className="flex flex-col gap-2 border-t border-border/70 px-2.5 py-2.5">
        {phases.map((phase, index) => (
          <PhaseCard
            key={phase.id}
            planId={plan.id}
            phase={phase}
            index={index}
            active={phase.id === activePhase?.id}
            docContent={docContent}
            onRequestDocContent={onRequestDocContent}
          />
        ))}
      </div>
    </article>
  );
}

function ExecutionFocus({ plans, runs }: { plans: Plan[]; runs: TodoRun[] }) {
  const activePlan = plans.find((plan) => plan.status === "active" || plan.status === "in_progress")
    ?? plans.find((plan) => !isTerminalPlan(plan.status) && plan.status !== "on_hold");
  const activeRun = runs.find((run) => !run.completedAt);
  if (!activePlan && !activeRun) return null;
  const activePhase = activePlan ? findActivePhase(activePlan) : undefined;
  const current = activePhase ? findCurrentStep(activePhase) : undefined;

  return (
    <section className="plan-focus" aria-label="Current execution focus">
      <div className="plan-focus-kicker">Current focus</div>
      <div className="plan-focus-title">{current?.title || current?.label || activeRun?.name || activePlan?.title || "No active step"}</div>
      <div className="plan-focus-copy">
        {activePlan && activePhase ? `${activePlan.title} · ${activePhase.title}` : activeRun ? `${activeRun.steps.length} task items in this run` : "Choose a plan to continue."}
      </div>
    </section>
  );
}

export function PlanningApp() {
  const [doc, setDoc] = useState<PlanningDoc>(EMPTY);
  const [counts, setCounts] = useState<Counts>({ activePlans: 0, activeTodos: 0, totalPlans: 0, totalTodos: 0 });
  const [docContent, setDocContent] = useState<Record<string, DocContentState>>({});

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === "planning_state") {
        setDoc(msg.document || EMPTY);
        if (msg.counts) setCounts(msg.counts);
      } else if (msg.type === "plan_doc_content") {
        const docId = String(msg.docId ?? "");
        if (!docId) return;
        setDocContent((prev) => ({
          ...prev,
          [docId]: msg.ok ? { status: "loaded", body: String(msg.body ?? "") } : { status: "error" },
        }));
      }
    });
    post({ type: "ready" });
    return off;
  }, []);

  function requestDocContent(planId: string, docId: string): void {
    setDocContent((prev) => ({ ...prev, [docId]: { status: "loading" } }));
    post({ type: "read_plan_doc", planId, docId });
  }

  const activePlans = doc.plans.filter((plan) => !isTerminalPlan(plan.status));
  const historicalPlans = doc.plans.filter((plan) => isTerminalPlan(plan.status));

  const chips = [
    `${counts.activePlans} active plan${counts.activePlans === 1 ? "" : "s"}`,
    `${counts.activeTodos} active run${counts.activeTodos === 1 ? "" : "s"}`,
    `${counts.totalPlans} total plan${counts.totalPlans === 1 ? "" : "s"}`,
  ];

  return (
    <div className="planning-root flex flex-1 flex-col overflow-hidden">
      <header className="planning-header shrink-0 border-b border-border px-3 py-2.5">
        <PanelHeader
          eyebrow="Execution ledger"
          title="Plans & Task Items"
          sub="Persistent milestones, approvals, and current agent work."
          status={{
            label: counts.activePlans || counts.activeTodos ? `${counts.activePlans + counts.activeTodos} active` : "Ready",
            tone: counts.activePlans || counts.activeTodos ? "ok" : "idle",
          }}
        />
        <div className="planning-header-actions mt-2 flex items-center justify-between gap-2">
          <div className="planning-stats flex flex-wrap gap-1">
            {chips.map((c) => <span key={c} className="rounded-full border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-xs text-muted-foreground">{c}</span>)}
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button size="xs" variant="outline" onClick={() => post({ type: "refresh" })}>Refresh</Button>
            <ConfirmButton label="Clear completed" confirmLabel="Confirm clear?" variant="outline" onConfirm={() => post({ type: "clear_completed" })} />
          </div>
        </div>
      </header>

      <main className="planning-content flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-4">
          <ExecutionFocus plans={activePlans} runs={doc.todoRuns} />
          <section className="planning-section flex flex-col gap-2">
            <div className="planning-section-header"><div className="eyebrow">Active plans</div><span>{activePlans.length}</span></div>
            {activePlans.length === 0 ? (
              <Empty>No active plans. Multi-stage work will appear here with its decisions, acceptance criteria, and progress.</Empty>
            ) : activePlans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} docContent={docContent} onRequestDocContent={requestDocContent} />
            ))}
          </section>

          {historicalPlans.length > 0 && (
            <section className="planning-section flex flex-col gap-2">
              <div className="planning-section-header"><div className="eyebrow">Plan history</div><span>{historicalPlans.length}</span></div>
              {historicalPlans.map((plan) => (
                <PlanCard key={plan.id} plan={plan} docContent={docContent} onRequestDocContent={requestDocContent} />
              ))}
            </section>
          )}

          <section className="planning-section flex flex-col gap-2">
            <div className="planning-section-header"><div className="eyebrow">Task items</div><span>{doc.todoRuns.length}</span></div>
            {doc.todoRuns.length === 0 ? (
              <Empty>No task-item runs yet. Tactical checklists appear here while the agent works through a larger step.</Empty>
            ) : doc.todoRuns.map((run) => {
              const progress = stepProgress(run.steps);
              return (
                <article key={run.id} className="planning-todo-card turn-in overflow-hidden rounded-xl border border-border bg-white/[0.03]">
                  <div className="flex items-start justify-between gap-2 p-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-base font-semibold text-foreground">{run.name || run.id}</span>
                        <StatusBadge status={todoStatus(run)} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">{run.id}</span>
                        <span>{progress.done}/{run.steps.length} done{progress.blocked ? `, ${progress.blocked} failed` : ""}</span>
                        <span>{run.phaseId ? `Linked to ${run.phaseId}` : "Standalone run"}</span>
                      </div>
                    </div>
                    {run.completedAt && <Button size="xs" variant="ghost" onClick={() => post({ type: "archive_todo", todoId: run.id })}>Archive</Button>}
                  </div>
                  <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
                    {run.steps.map((step) => (
                      <StepRow key={step.id} idLabel={step.id} primary={step.label || ""} detail={step.result} status={step.status} />
                    ))}
                  </div>
                </article>
              );
            })}
          </section>
        </div>
      </main>
    </div>
  );
}
