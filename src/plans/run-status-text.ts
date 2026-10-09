/**
 * How a plan run reads in the status bar: one icon, a few words, and a tooltip with the rest.
 *
 * The item has to answer three questions at a glance — is it working, does it need me, is it
 * done — without being opened, and has to stay put after the run ends until someone has seen the
 * result. Pure so the wording can be tested without a status bar.
 */

import { formatDuration, type PlanRunView } from "./plan-run-model.js";

export interface RunPresentation {
  /** A codicon id, e.g. `$(bell)`. */
  icon: string;
  text: string;
  tooltip: string;
  /** The run has ended. Such an item stays until acknowledged, then goes. */
  ended: boolean;
  /** Shown with the warning colour: the run cannot go on without a person. */
  pressing: boolean;
}

function position(view: PlanRunView): string {
  return view.stepsTotal > 0 ? `${view.stepPosition}/${view.stepsTotal}` : "";
}

export function presentRun(view: PlanRunView): RunPresentation {
  const where = position(view);
  const lines = [
    `Plan run: ${view.planTitle}`,
    where ? `Step ${where}${view.phaseTitle ? ` · ${view.phaseTitle}` : ""}` : "",
    view.currentStep ? `Now: ${view.currentStep.title}` : "",
    `Elapsed ${formatDuration(view.elapsedMs)} · $${view.spentUsd.toFixed(2)}${view.maxUsd ? ` of $${view.maxUsd.toFixed(2)}` : ""}`,
  ].filter(Boolean);
  const tip = (extra?: string): string => [...(extra ? [extra] : []), ...lines, "Click to open Blacksite."].join("\n");
  const clock = formatDuration(view.elapsedMs);

  switch (view.liveState) {
    case "working":
      return { icon: "$(loading~spin)", text: [where, clock].filter(Boolean).join(" · "), tooltip: tip(), ended: false, pressing: false };
    case "quiet":
      return {
        icon: "$(loading~spin)",
        text: [where, `quiet ${formatDuration(view.quietMs ?? 0)}`].filter(Boolean).join(" · "),
        tooltip: tip("Nothing has come back from the agent for a while."),
        ended: false,
        pressing: false,
      };
    case "needs_you":
      return { icon: "$(bell)", text: ["Needs you", where].filter(Boolean).join(" · "), tooltip: tip("The run is waiting for you."), ended: false, pressing: true };
    case "provider":
      return { icon: "$(sync~spin)", text: ["Waiting for the model", where].filter(Boolean).join(" · "), tooltip: tip(view.providerWaitReason), ended: false, pressing: false };
    case "paused":
      return { icon: "$(debug-pause)", text: ["Paused", where].filter(Boolean).join(" · "), tooltip: tip(view.endReason), ended: false, pressing: false };
    case "interrupted":
      return { icon: "$(warning)", text: ["Interrupted", where].filter(Boolean).join(" · "), tooltip: tip("VS Code closed while the run was working. Resume it from the run bar."), ended: false, pressing: true };
    case "failed":
      return { icon: "$(error)", text: ["Stopped", where].filter(Boolean).join(" · "), tooltip: tip(view.endReason), ended: view.status === "budget_exhausted", pressing: true };
    case "done":
      return { icon: "$(check)", text: `Plan done · ${clock}`, tooltip: tip("Every step is done."), ended: true, pressing: false };
    case "stopped":
      return { icon: "$(circle-slash)", text: "Run stopped", tooltip: tip(view.endReason), ended: true, pressing: false };
  }
}
