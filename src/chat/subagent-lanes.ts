/*
  Delegated subagent lanes: budget resolution, lane identity, the stall/runtime watchdog,
  failure classification and its next-step guidance, the prompts a delegated lane runs under,
  and child-event namespacing back into the parent stream.

  Extracted from chat-provider.ts, which re-exports these so existing call sites and specs
  keep importing them from there. This is the lane *policy* — pure decisions about budgets,
  timeouts and message shaping. Actually running a lane still lives on ChatProvider, which
  owns the session and webview plumbing a lane needs.
*/
import { SERVICE_TOOLS } from "../tools/definitions.js";
import type { ApprovalDecision } from "../approval-gate.js";
import type { AgentSession } from "../agent-session.js";
import type {
  AgentEvent,
  BaseAgentEvent,
  SubagentBudgetSummary,
  SubagentFailureKind,
  SubagentSpawnFailureResult,
  SubagentProviderMessage,
  SubagentSpawnInput,
  SubagentTraceEntry,
} from "../agent-session.js";

export type ResolvedSubagentBudget = SubagentBudgetSummary & {
  maxIterations: number;
};

/** Privileged tools withheld from delegated lanes: the tree stays one level deep and only the
 *  parent receives credentials for external service integrations. */
/**
 * How a lane resolves an approval when nobody is attending it.
 *
 * Returning a decision settles the gate without a prompt; returning null falls through to the
 * interactive path. A headless caller that supplies no policy still prompts — which is why
 * loops always supply one, and why "auto-approve nothing" is spelled as a policy that denies
 * rather than as the absence of a policy.
 */
export type HeadlessApprovalPolicy = (
  tier: string,
  toolName: string,
  description: string,
) => ApprovalDecision | null | Promise<ApprovalDecision | null>;

export const DELEGATED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_followup",
  // External-service credentials and side effects stay with the parent lane, whose context
  // includes the user's request and approval history. Delegates report the desired operation.
  ...SERVICE_TOOLS.map((tool) => tool.name),
  // MCP calls can launch configured local processes or invoke opaque remote side effects.
  // Delegates request them through the supervising parent rather than inheriting that authority.
  "mcp_list_tools",
  "mcp_call_tool",
];

export function makeLaneId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeDelegatedComplexity(input: SubagentSpawnInput): Exclude<SubagentSpawnInput["complexity"], "auto" | undefined> {
  if (input.complexity === "standard" || input.complexity === "complex" || input.complexity === "deep") return input.complexity;
  const chars = input.task.length + (input.context?.length ?? 0);
  if (chars > 10_000) return "deep";
  if (chars > 3_000) return "complex";
  return "standard";
}

/**
 * Two clocks rather than one, because "still working" and "taking too long" are different
 * failures and only the second is worth killing a lane for.
 *
 * idleTimeoutSeconds is a *silence* window, not a run budget: it is only consumed while the
 * child emits nothing at all. It stays as generous as the old whole-run budget was, because a
 * single tool call (a test suite, a build) legitimately produces no events while it runs.
 *
 * maxRuntimeSeconds is the real ceiling, several times larger, and excludes time the lane
 * spent blocked on a human. A productive lane now gets the room it was previously denied,
 * while a lane that is genuinely spinning still dies.
 */
export function resolveSubagentBudget(input: SubagentSpawnInput, sessionMaxIterations: number): ResolvedSubagentBudget {
  const complexity = normalizeDelegatedComplexity(input);
  const idleTimeoutSeconds = complexity === "deep" ? 420 : complexity === "complex" ? 240 : 120;
  const maxRuntimeSeconds = complexity === "deep" ? 2400 : complexity === "complex" ? 1200 : 600;
  const maxToolRounds = complexity === "deep" ? 14 : complexity === "complex" ? 10 : 6;
  const maxIterations = Math.min(Math.max(sessionMaxIterations, maxToolRounds + 2), maxToolRounds + 4);
  return { complexity, idleTimeoutSeconds, maxRuntimeSeconds, maxToolRounds, maxIterations };
}

// ── Lane watchdog ──────────────────────────────────────────────────────────────

/** Why a watchdog aborted a lane. Both read as a "timeout" to the parent, but they call for
 *  different retries: a stall means the lane died holding still, a runtime cap means it died
 *  busy — the first is usually a wedged tool, the second an over-scoped task. */
export const LANE_STALL_REASON = "Delegated lane stalled with no progress.";
export const LANE_RUNTIME_CAP_REASON = "Delegated lane hit its runtime ceiling.";

export function isLaneTimeoutReason(reason: unknown): boolean {
  return reason === LANE_STALL_REASON || reason === LANE_RUNTIME_CAP_REASON;
}

/** Any event out of the child proves it is alive, so the idle window resets on all of them
 *  except the two pairs below, which mean the opposite. */
export const LANE_BLOCKING_EVENTS: ReadonlySet<string> = new Set(["approval_pending", "question_card_pending"]);
export const LANE_UNBLOCKING_EVENTS: ReadonlySet<string> = new Set(["approval_result", "question_card_result"]);

export interface LaneWatchdog {
  /** Feed one event from the child. */
  note(event: { type: string }): void;
  stop(): void;
  /** Wall-clock ms spent blocked on a human, excluded from both budgets. */
  readonly blockedMs: number;
}

/** Injectable so the tests can drive the clock instead of waiting out real minutes. */
export interface LaneWatchdogClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const REAL_LANE_CLOCK: LaneWatchdogClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Replaces the fixed `setTimeout(budget)` that used to arm at spawn and fire whether or not
 * the lane was still working.
 *
 * The timer is deliberately lazy: progress events only stamp `lastProgressAt` and never touch
 * the timer, so a lane streaming a token at a time does not churn a clearTimeout/setTimeout
 * pair per token. When the armed timer does fire it recomputes both deadlines and re-arms for
 * whatever is actually left, so at most one wakeup per idle window is wasted.
 */
export function createLaneWatchdog(
  budget: { idleTimeoutSeconds: number; maxRuntimeSeconds: number },
  abort: (reason: string) => void,
  clock: LaneWatchdogClock = REAL_LANE_CLOCK,
): LaneWatchdog {
  const idleMs = Math.max(budget.idleTimeoutSeconds, 1) * 1000;
  const runtimeMs = Math.max(budget.maxRuntimeSeconds, budget.idleTimeoutSeconds, 1) * 1000;
  const startedAt = clock.now();

  let lastProgressAt = startedAt;
  let blockedSince = 0;
  let blockedMs = 0;
  // A count, not a flag: a lane can have more than one approval outstanding, and the clock
  // must not restart until the last of them is answered.
  let blockedDepth = 0;
  let handle: unknown = null;
  let stopped = false;

  const clear = (): void => {
    if (handle === null) return;
    clock.clearTimer(handle);
    handle = null;
  };

  const arm = (): void => {
    clear();
    if (stopped || blockedDepth > 0) return;
    const now = clock.now();
    const idleLeft = idleMs - (now - lastProgressAt);
    const runtimeLeft = runtimeMs - (now - startedAt - blockedMs);
    if (idleLeft <= 0 || runtimeLeft <= 0) {
      stopped = true;
      abort(idleLeft <= 0 ? LANE_STALL_REASON : LANE_RUNTIME_CAP_REASON);
      return;
    }
    handle = clock.setTimer(() => {
      handle = null;
      arm();
    }, Math.min(idleLeft, runtimeLeft));
  };

  arm();

  return {
    get blockedMs() {
      return blockedMs + (blockedDepth > 0 ? Math.max(clock.now() - blockedSince, 0) : 0);
    },
    note(event) {
      if (stopped) return;
      if (LANE_BLOCKING_EVENTS.has(event.type)) {
        if (blockedDepth === 0) blockedSince = clock.now();
        blockedDepth += 1;
        // Both clocks stop entirely: a lane waiting on a person is not failing, and the
        // person may take arbitrarily long to answer.
        clear();
        return;
      }
      if (LANE_UNBLOCKING_EVENTS.has(event.type)) {
        if (blockedDepth === 0) return;
        blockedDepth -= 1;
        if (blockedDepth > 0) return;
        blockedMs += Math.max(clock.now() - blockedSince, 0);
        lastProgressAt = clock.now();
        arm();
        return;
      }
      lastProgressAt = clock.now();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

/** Trace entries retained for a failed lane. Enough to reconstruct what it covered without
 *  pushing a large tool log back into the parent's context on every failure. */
export const SUBAGENT_TRACE_LIMIT = 20;
export const SUBAGENT_PARTIAL_ANSWER_LIMIT = 4000;
export const SUBAGENT_FILES_LIMIT = 30;

/** Argument keys that carry a workspace path across the tool surface. */
export const PATH_ARG_KEYS = ["path", "filePath", "file", "target", "directory", "dir"];

export function collectTouchedPath(input: Record<string, unknown>, into: Set<string>): void {
  if (into.size >= SUBAGENT_FILES_LIMIT) return;
  for (const key of PATH_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      into.add(value.trim());
      return;
    }
  }
}

export function classifyLaneFailure(timedOut: boolean, cancelled: boolean, answer: string): SubagentFailureKind {
  if (timedOut) return "timeout";
  if (cancelled) return "cancelled";
  return answer ? "error" : "no_answer";
}

/**
 * Retry-or-continue guidance, written for the parent agent rather than the user.
 *
 * The distinction that matters: a timeout means the lane was still making progress when the
 * clock ran out, so more budget plausibly finishes it. A no_answer means it ran to completion
 * and still produced nothing, so an identical respawn is likely to repeat that outcome.
 */
export function laneFailureNextStep(kind: SubagentFailureKind, budget: ResolvedSubagentBudget, hasPartial: boolean): string {
  const partialClause = hasPartial
    ? "Read partialAnswer first — if it already covers what you delegated, continue without respawning."
    : "The lane produced no partial answer, so executionTrace and filesTouched are the only salvage.";
  switch (kind) {
    case "timeout":
      return `${partialClause} The lane was cut off — it went quiet for ${budget.idleTimeoutSeconds}s, or ran past its ${budget.maxRuntimeSeconds}s ceiling or ${budget.maxToolRounds}-round budget — rather than finishing, so a respawn is worthwhile if the gap is real. Narrow the task to what is still missing, or raise complexity (currently "${budget.complexity}") for a larger budget. Do not re-delegate work the trace shows is already done.`;
    case "cancelled":
      return `${partialClause} The lane was cancelled, not exhausted — nothing here indicates the task itself is unworkable.`;
    case "no_answer":
      return `${partialClause} The lane ran to completion and still returned nothing, so an identical respawn will likely repeat this. Either restate the task more concretely or do the work yourself.`;
    default:
      return `${partialClause} Judge from executionTrace whether the failure was incidental (retry) or inherent to how the task was framed (restate it or do the work yourself).`;
  }
}

/** How many finished lanes stay resumable by subagent_followup. Each holds a full child
 *  conversation that is otherwise never reclaimed, so this is a memory bound, not a policy. */
export const MAX_RESUMABLE_LANES = 8;

export interface RetainedLane {
  laneId: string;
  label: string;
  session: AgentSession;
}

export interface LaneRunOutcome {
  stopReason: string;
  errorMessage: string;
  executionTrace: SubagentTraceEntry[];
  executionTraceTruncated: boolean;
  filesTouched: Set<string>;
  /** Uncapped, unlike executionTrace.length. */
  toolCallCount: number;
}

export function newLaneOutcome(): LaneRunOutcome {
  return {
    stopReason: "",
    errorMessage: "",
    executionTrace: [],
    executionTraceTruncated: false,
    filesTouched: new Set<string>(),
    toolCallCount: 0,
  };
}

/**
 * Relay a child session's events as lane events while accumulating the forensics a failure
 * needs, shared by the spawn and follow-up paths.
 *
 * Yields as it goes rather than collecting first: the transcript renders these live, and
 * buffering them would make a lane look frozen until it finished. Harvesting here rather
 * than from history afterwards also survives a timeout, which aborts the child mid-flight
 * before its last rounds are ever recorded.
 *
 * This is also the single point every child event passes through on both the spawn and
 * follow-up paths, which is why the watchdog is fed from here rather than from each caller.
 */
export async function* streamLaneRun(
  events: AsyncGenerator<AgentEvent>,
  parentToolCallId: string,
  laneId: string,
  outcome: LaneRunOutcome,
  watchdog?: LaneWatchdog,
): AsyncGenerator<SubagentProviderMessage> {
  try {
    for await (const event of events) {
      if (!isBaseAgentEvent(event)) continue;
      watchdog?.note(event);
      if (event.type === "turn_complete") outcome.stopReason = event.stopReason;
      if (event.type === "error") outcome.errorMessage = event.message;
      if (event.type === "tool_call_start") collectTouchedPath(event.input, outcome.filesTouched);
      if (event.type === "tool_call_result") {
        outcome.toolCallCount += 1;
        outcome.executionTrace.push({ tool: event.toolName, ok: event.ok, summary: event.summary });
        if (outcome.executionTrace.length > SUBAGENT_TRACE_LIMIT) {
          outcome.executionTrace.shift();
          outcome.executionTraceTruncated = true;
        }
      }
      yield { type: "subagent_lane_event", parentToolCallId, laneId, event: namespaceChildEvent(laneId, event) };
    }
  } catch (err) {
    // Captured rather than propagated so the caller still emits its lane_complete and
    // tool_result; throwing here would lose the lane closure entirely.
    outcome.errorMessage = err instanceof Error ? err.message : String(err);
  }
}

/** Sentence fragment naming which of the two clocks actually ran out, so the parent's retry
 *  is informed by whether the lane died holding still or died busy. */
export function laneTimeoutDetail(reason: unknown, budget: ResolvedSubagentBudget): string {
  return reason === LANE_RUNTIME_CAP_REASON
    ? `ran past its ${budget.maxRuntimeSeconds}s runtime ceiling.`
    : `stalled — it produced nothing at all for ${budget.idleTimeoutSeconds}s.`;
}

/** A follow-up that cannot run at all still answers in the failure shape the parent already
 *  knows how to read, rather than a bare error the agent has to special-case. */
export function laneUnavailableFailure(subRequestId: string, error: string): SubagentSpawnFailureResult {
  return {
    ok: false,
    subRequestId,
    error,
    failureKind: "error",
    budget: { complexity: "standard", idleTimeoutSeconds: 0, maxRuntimeSeconds: 0, maxToolRounds: 0 },
    toolRounds: 0,
    elapsedMs: 0,
    stopReason: "",
    partialAnswer: "",
    executionTrace: [],
    executionTraceTruncated: false,
    filesTouched: [],
    nextStep: "Spawn a fresh lane with subagent_spawn, including whatever context you already gathered.",
  };
}

export function followUpLanePrompt(message: string): string {
  return `Follow-up from the parent agent on the task you already completed in this lane:\n${message.trim()}`;
}

export function delegatedLanePrompt(task: string, context?: string): string {
  const trimmedContext = context?.trim();
  return trimmedContext
    ? `Delegated task:\n${task.trim()}\n\nAdditional context:\n${trimmedContext}`
    : `Delegated task:\n${task.trim()}`;
}

export function buildDelegatedSystemPrompt(basePrompt: string, budget: ResolvedSubagentBudget, profileAddition?: string): string {
  const lines = [
    "You are a delegated Blacksite subagent running one focused lane for a parent agent.",
    "Stay tightly scoped to the delegated task. Gather evidence, make changes if needed, and return a concise synthesis for the parent to integrate.",
    "In that synthesis, separate what you verified (and how) from what you inferred, and name every file you changed. The parent decides what to re-check on the strength of that line, so an inference presented as a result propagates straight into its work.",
    "Do not address the end user directly. Do not explain the parent workflow. Work only within this lane.",
    "Execution Runs are owned by the parent agent. Do not create, execute, resume, compare, annotate, or review retained runs; report proposed verification targets and evidence needs back to the parent.",
    "If you need user approval, ask through the provided tools. If information is missing, state the gap clearly in the final answer.",
    `Execution budget: ${budget.complexity} complexity, ${budget.maxToolRounds} tool rounds, ${budget.maxRuntimeSeconds}s total runtime. Long-running work is fine — the lane is only cut short if it produces nothing at all for ${budget.idleTimeoutSeconds}s.`,
  ];
  if (profileAddition?.trim()) {
    lines.push("", `Profile guidance: ${profileAddition.trim()}`);
  }
  lines.push("", basePrompt);
  return lines.join("\n");
}

export function extractLatestAssistantText(history: Array<{ role: string; content: unknown }>): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function isBaseAgentEvent(event: AgentEvent): event is BaseAgentEvent {
  return event.type !== "subagent_lane_start"
    && event.type !== "subagent_lane_event"
    && event.type !== "subagent_lane_complete";
}

export function namespaceChildEvent(laneId: string, event: BaseAgentEvent): BaseAgentEvent {
  const namespacedId = (toolCallId: string): string => `${laneId}:${toolCallId}`;
  switch (event.type) {
    case "tool_call_start":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "tool_call_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "approval_pending":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "approval_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "question_card_pending":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "question_card_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    default:
      return event;
  }
}
