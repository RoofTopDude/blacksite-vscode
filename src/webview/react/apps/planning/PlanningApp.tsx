import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { post, onMessage } from "@/lib/bridge";

interface Step { id: string; title?: string; label?: string; status: string; detail?: string; result?: string; }
interface Phase { id: string; title: string; objective?: string; status: string; steps: Step[]; }
interface Plan { id: string; title: string; summary?: string; status: string; activePhaseId?: string; phases: Phase[]; }
interface TodoRun { id: string; name: string; completedAt?: string; steps: Step[]; phaseId?: string; }
interface PlanningDoc { plans: Plan[]; todoRuns: TodoRun[]; }
interface Counts { activePlans: number; activeTodos: number; totalPlans: number; totalTodos: number; }

const EMPTY: PlanningDoc = { plans: [], todoRuns: [] };

function Empty({ children }: { children: string }) {
  return <div className="rounded-lg border border-dashed border-border bg-white/[0.02] p-4 text-[11px] leading-relaxed text-muted-foreground">{children}</div>;
}

function StepRow({ idLabel, primary, detail, status }: { idLabel: string; primary: string; detail?: string; status: string }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
      <div className="min-w-0">
        <div className="text-[11px] text-foreground"><span className="font-mono text-muted-foreground">{idLabel}</span> {primary}</div>
        {detail && <div className="mt-0.5 text-[10px] text-muted-foreground">{detail}</div>}
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function todoStatus(run: TodoRun): string {
  if (run.completedAt) return run.steps.some((s) => s.status === "failed") ? "failed" : "completed";
  return run.steps.some((s) => s.status === "running") ? "running" : "pending";
}

/** User controls to hold / resume / cancel / reopen / archive a plan. */
function PlanControls({ status, planId }: { status: string; planId: string }) {
  const setStatus = (s: string) => post({ type: "set_plan_status", planId, status: s });
  const terminal = status === "completed" || status === "cancelled";
  return (
    <div className="flex shrink-0 items-center gap-1">
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
          <Button size="xs" variant="ghost" onClick={() => post({ type: "archive_plan", planId })}>Archive</Button>
        </>
      )}
    </div>
  );
}

export function PlanningApp() {
  const [doc, setDoc] = useState<PlanningDoc>(EMPTY);
  const [counts, setCounts] = useState<Counts>({ activePlans: 0, activeTodos: 0, totalPlans: 0, totalTodos: 0 });

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === "planning_state") {
        setDoc(msg.document || EMPTY);
        if (msg.counts) setCounts(msg.counts);
      }
    });
    post({ type: "ready" });
    return off;
  }, []);

  const chips = [
    `${counts.activePlans} active plan${counts.activePlans === 1 ? "" : "s"}`,
    `${counts.activeTodos} active run${counts.activeTodos === 1 ? "" : "s"}`,
    `${counts.totalPlans} total plan${counts.totalPlans === 1 ? "" : "s"}`,
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="text-[13px] font-semibold text-foreground">Plans &amp; Task Items</div>
        <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">Persistent phased plans and live execution steps the agent maintains across conversations.</div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {chips.map((c) => <span key={c} className="rounded-full border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{c}</span>)}
          </div>
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={() => post({ type: "refresh" })}>Refresh</Button>
            <Button size="xs" variant="outline" onClick={() => post({ type: "clear_completed" })}>Clear done</Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.07em] text-muted-foreground">Plans</div>
            {doc.plans.length === 0 ? (
              <Empty>No plans yet. The agent creates phased plans with plan_create and updates them with plan_update.</Empty>
            ) : doc.plans.map((plan) => (
              <article key={plan.id} className="overflow-hidden rounded-xl border border-border bg-white/[0.03]">
                <div className="flex items-start justify-between gap-2 p-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-foreground">{plan.title || plan.id}</span>
                      <StatusBadge status={plan.status || "active"} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{plan.summary || "No summary provided."}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[9.5px] text-muted-foreground">
                      <span className="font-mono">{plan.id}</span>
                      <span>{plan.phases.length} phase{plan.phases.length === 1 ? "" : "s"}</span>
                      <span>{plan.activePhaseId ? `Current: ${plan.activePhaseId}` : "No active phase"}</span>
                    </div>
                  </div>
                  <PlanControls status={plan.status} planId={plan.id} />
                </div>
                <div className="flex flex-col gap-2 px-2.5 pb-2.5">
                  {plan.phases.map((phase) => {
                    const current = phase.steps.find((s) => s.status === "in_progress") || phase.steps.find((s) => s.status === "pending");
                    return (
                      <div key={phase.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-white/[0.025] p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[11.5px] font-medium text-foreground">{phase.title || phase.id}</div>
                            <div className="text-[10px] text-muted-foreground">{phase.objective || "No objective recorded."}</div>
                            <div className="font-mono text-[9.5px] text-muted-foreground">{current ? `Next: ${current.id} ${current.title}` : "No remaining steps."}</div>
                          </div>
                          <StatusBadge status={phase.status || "pending"} />
                        </div>
                        {phase.steps.map((step) => (
                          <StepRow key={step.id} idLabel={step.id} primary={step.title || ""} detail={step.detail} status={step.status || "pending"} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.07em] text-muted-foreground">Task Items</div>
            {doc.todoRuns.length === 0 ? (
              <Empty>No task-item runs yet. The agent creates them with todo_create and keeps them live with todo_update.</Empty>
            ) : doc.todoRuns.map((run) => {
              const done = run.steps.filter((s) => s.status === "done").length;
              const failed = run.steps.filter((s) => s.status === "failed").length;
              return (
                <article key={run.id} className="overflow-hidden rounded-xl border border-border bg-white/[0.03]">
                  <div className="flex items-start justify-between gap-2 p-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-semibold text-foreground">{run.name || run.id}</span>
                        <StatusBadge status={todoStatus(run)} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[9.5px] text-muted-foreground">
                        <span className="font-mono">{run.id}</span>
                        <span>{done}/{run.steps.length} done{failed ? `, ${failed} failed` : ""}</span>
                        <span>{run.phaseId ? `Phase ${run.phaseId}` : "No linked phase"}</span>
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
      </div>
    </div>
  );
}
