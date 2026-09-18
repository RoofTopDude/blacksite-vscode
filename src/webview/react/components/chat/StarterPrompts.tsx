import { ClipboardCheck, SearchCode, Wrench, GitBranchPlus } from "lucide-react";
import type { RequestMode } from "@/lib/protocol";
export interface StarterPrompt { prompt: string; mode: RequestMode; }
const BLUEPRINTS = [
  {
    id: "plan",
    mode: "plan",
    label: "Plan",
    icon: GitBranchPlus,
    prompt: "Planning goal:\n\nContext:\n- \n\nConstraints and non-goals:\n- \n\nPlease research the relevant code and produce an implementation-ready, phase-by-phase plan. Surface material decisions as focused questions and do not implement yet.",
  },
  {
    id: "fix",
    mode: "debug",
    label: "Fix",
    icon: Wrench,
    prompt: "Problem:\n\nObserved behavior:\n\nExpected behavior:\n\nRelevant files or errors:\n- \n\nPlease reproduce or trace the issue, make the fix, and run targeted validation.",
  },
  {
    id: "review",
    mode: "review",
    label: "Review",
    icon: ClipboardCheck,
    prompt: "Review focus:\n- Bugs or regressions\n- Missing validation\n- UX or maintainability risks\n\nScope:\n\nPlease lead with findings, include file/line references, and separate assumptions from confirmed issues.",
  },
  {
    id: "trace",
    mode: "review",
    label: "Trace",
    icon: SearchCode,
    prompt: "Trace this workflow end to end:\n\nEntry point:\n\nState or message path:\n\nWhat I need to understand:\n\nPlease map the contracts, likely failure points, and the safest change path.",
  },
] as const;

export function StarterPrompts({ onChoose }: { onChoose: (prompt: StarterPrompt) => void }) {
  return <div className="starter-prompts" aria-label="Start a task">{BLUEPRINTS.map(({ id, icon: Icon, label, prompt, mode }) => (
    <button key={id} type="button" onClick={() => onChoose({ prompt, mode })} className="starter-prompt">
      <Icon aria-hidden="true" /><span>{label === "Plan" ? "Plan a change" : label === "Fix" ? "Fix an issue" : label === "Review" ? "Review code" : "Trace a workflow"}</span>
    </button>
  ))}</div>;
}
