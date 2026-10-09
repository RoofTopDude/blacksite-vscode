import { useEffect, useState } from "react";
import { AlertTriangle, Info, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { PlanRunCharterInput, PreflightReport } from "@/lib/protocol";
import { Button } from "@/components/ui/button";

const field = "h-7 w-20 rounded-md border border-input bg-transparent px-2 text-right text-sm tabular-nums outline-none focus:border-ring";

/**
 * Read once, before leaving it alone for hours.
 *
 * Findings are warnings, never blockers: a plan with gaps starts exactly as readily as one
 * without, but the user has seen the gaps. The charter is what they agree to — the ceilings the
 * model cannot raise, what happens if the run needs them and they are away, and how loudly it
 * should tell them when it is done.
 */
export function RunPreflight() {
  const store = useStore();
  const report = store.runPreflight;
  useEffect(() => {
    if (!report) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") actions.closeRunPreflight(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [report]);
  if (!report) return null;
  return <Dialog key={report.planId} report={report} />;
}

function Dialog({ report }: { report: PreflightReport }) {
  const store = useStore();
  const [maxUsd, setMaxUsd] = useState(report.defaultMaxUsd ? String(report.defaultMaxUsd) : "");
  const [maxMinutes, setMaxMinutes] = useState("");
  const [blocked, setBlocked] = useState<"wait" | "pause">("pause");
  const [blockedMinutes, setBlockedMinutes] = useState("30");
  const [notifications, setNotifications] = useState<"attention" | "all" | "off">("attention");

  function start(): void {
    const charter: PlanRunCharterInput = { notifications };
    const usd = Number(maxUsd);
    const minutes = Number(maxMinutes);
    const away = Number(blockedMinutes);
    if (Number.isFinite(usd) && usd > 0) charter.maxUsd = usd;
    if (Number.isFinite(minutes) && minutes > 0) charter.maxMinutes = minutes;
    if (blocked === "pause" && Number.isFinite(away) && away > 0) charter.pauseWhenBlockedMinutes = away;
    actions.startPlanRun(report.planId, charter);
  }

  const warnings = report.findings.filter((finding) => finding.level === "warn");
  const notes = report.findings.filter((finding) => finding.level === "info");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Start a plan run"
      onClick={(event) => { if (event.target === event.currentTarget) actions.closeRunPreflight(); }}
      className="fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-8"
    >
      <div className="lightbox-media-in flex w-full max-w-[34rem] flex-col gap-3 rounded-xl border border-border bg-popover p-4 shadow-2xl">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Plan run</div>
            <div className="truncate text-lg font-semibold" title={report.planTitle}>{report.planTitle}</div>
            <div className="text-xs text-muted-foreground">
              {report.stepsOpen} of {report.stepsTotal} steps open · {report.phaseCount} phase{report.phaseCount === 1 ? "" : "s"}
            </div>
          </div>
          <button type="button" className="chat-interactive rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => actions.closeRunPreflight()} title="Close without starting" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {report.blocker && (
          <div role="alert" className="rounded-md border border-[color:var(--s-err)]/40 bg-[color:var(--s-err)]/10 px-3 py-2 text-sm">{report.blocker}</div>
        )}

        <section aria-label="What was found in the plan" className="flex flex-col gap-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Before you leave it</div>
          {report.findings.length === 0 && <div className="text-sm text-muted-foreground">Nothing to flag. Every open step says how it will be checked.</div>}
          {[...warnings, ...notes].map((finding, index) => (
            <div key={index} className="flex gap-2 text-sm">
              {finding.level === "warn"
                ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--s-warn)" }} aria-hidden />
                : <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div>{finding.message}</div>
                {finding.examples && <div className="truncate text-xs text-muted-foreground" title={finding.examples.join("\n")}>e.g. {finding.examples.join(" · ")}</div>}
                {finding.fix && (
                  <button type="button" className="chat-interactive mt-0.5 text-xs text-primary hover:underline" onClick={() => { actions.closeRunPreflight(); actions.injectContext(finding.fix!, "Plan run preflight"); }} title="Put this request in the composer so you can send it to the agent.">
                    Ask the agent to fix this
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>

        {report.projects.length > 0 && (
          <section aria-label="Projects this plan touches" className="flex flex-col gap-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Projects it will touch</div>
            {report.projects.map((project) => (
              <div key={project.root} className="flex items-start gap-2 text-sm">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: project.issues.length ? "var(--s-warn)" : "var(--s-ok)" }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={project.root}>{project.name}</div>
                  {project.issues.map((issue, i) => <div key={i} className="text-xs text-[color:var(--s-warn)]">{issue}</div>)}
                </div>
              </div>
            ))}
            {report.moreProjects > 0 && <div className="text-xs text-muted-foreground">and {report.moreProjects} more</div>}
            {report.projects.some((project) => project.issues.length > 0) && (
              <button type="button" className="chat-interactive self-start text-xs text-primary hover:underline" onClick={() => { actions.closeRunPreflight(); actions.setView("settings"); actions.openProjectSetup(); }} title="Open Settings › Project setup to install or point to what is missing.">
                Set up the missing tools…
              </button>
            )}
          </section>
        )}

        <section aria-label="What you are agreeing to" className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">While it runs</div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span title="Destructive operations, service changes and anything outside the workspace always ask, whatever this is set to.">Approvals</span>
            <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label="Approval mode">
              {(["ask", "auto"] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={store.approvalMode === mode} onClick={() => actions.setApprovalMode(mode)}
                  className={cn("px-2.5 py-1 text-xs font-medium", store.approvalMode === mode ? "bg-primary/20 text-foreground" : "text-muted-foreground hover:text-foreground")}
                  title={mode === "ask" ? "Ask before every gated operation. A run in this mode stops at each one until you answer." : "Routine operations are approved by a separate reviewer; the rest still ask."}>
                  {mode === "ask" ? "Ask" : "Auto"}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm" title="The run stops when it has spent this much. Leave empty for no ceiling.">
            <span>Stop at</span>
            <span className="inline-flex items-center gap-1">$<input className={field} inputMode="decimal" value={maxUsd} placeholder="none" onChange={(event) => setMaxUsd(event.target.value)} aria-label="Spend ceiling in dollars" /></span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm" title="The run stops after this long, counting time spent waiting but not time paused. Leave empty for no limit.">
            <span>Stop after</span>
            <span className="inline-flex items-center gap-1"><input className={field} inputMode="numeric" value={maxMinutes} placeholder="none" onChange={(event) => setMaxMinutes(event.target.value)} aria-label="Time limit in minutes" />min</span>
          </label>
          <div className="flex items-center justify-between gap-3 text-sm" title="What happens when the run needs an answer and you are not there.">
            <span>If it needs me</span>
            <span className="inline-flex items-center gap-1.5">
              <select className="h-7 rounded-md border border-input bg-popover px-1.5 text-sm" value={blocked} onChange={(event) => setBlocked(event.target.value as "wait" | "pause")} aria-label="When blocked on you">
                <option value="pause">Pause after</option>
                <option value="wait">Keep waiting</option>
              </select>
              {blocked === "pause" && <><input className={field} inputMode="numeric" value={blockedMinutes} onChange={(event) => setBlockedMinutes(event.target.value)} aria-label="Minutes to wait" />min</>}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 text-sm" title="How loudly to tell you outside the chat. Nothing is shown while you are looking at it.">
            <span>Tell me</span>
            <select className="h-7 rounded-md border border-input bg-popover px-1.5 text-sm" value={notifications} onChange={(event) => setNotifications(event.target.value as "attention" | "all" | "off")} aria-label="Notifications">
              <option value="attention">When it needs me or finishes</option>
              <option value="all">About every wait and pause</option>
              <option value="off">Never</option>
            </select>
          </div>
        </section>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => actions.closeRunPreflight()}>Cancel</Button>
          <Button size="sm" disabled={!report.canStart} onClick={start} title={report.canStart ? "Start working through the plan now." : report.blocker}>
            <Play className="size-3.5" />Start run
          </Button>
        </div>
      </div>
    </div>
  );
}
