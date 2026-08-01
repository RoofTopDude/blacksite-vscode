/**
 * The conductor: an agent that decides whether long-horizon work should continue, and writes
 * the message that continues it.
 *
 * The problem this exists for. A plan running for hours stalls — the executing agent asks a
 * question about a later phase, a lane is interrupted, a step fails twice. Something has to
 * decide what happens next. The naive answer is to auto-send "continue", and it is wrong twice
 * over: it cannot answer the question the executor actually asked, and it will cheerfully push
 * past a stop that should have been permanent.
 *
 * So the decision is made by a fresh agent holding three things the executor no longer has:
 *
 *  1. **The user's original prompts, verbatim.** This is the load-bearing input. An executor
 *     forty steps deep has compacted, summarized, or simply drifted away from what was asked.
 *     Only something holding the original words can notice that the work has wandered — which
 *     is why `intent_drift` is a halt category and not a footnote.
 *  2. **The plan as a whole**, including phases the executor has not reached, so a question
 *     about an upcoming step is answerable rather than deferred.
 *  3. **No hands.** The conductor has no write tools. It reads and rules. A decider that can
 *     also act has an interest in its own verdict.
 *
 * The conductor can end the work. `halt` is a first-class outcome, not a failure path, and the
 * executor does not get a vote on it.
 */

export type HaltCategory =
  /** Continuing would cause harm — data loss, a destructive operation on real state. */
  | "safety"
  /** Credentials, secrets, permissions, or auth surface. A human decides these. */
  | "security"
  /** The next action cannot be undone: a force push, a migration, a deploy, a release. */
  | "irrecoverable"
  /** What is about to happen is not what the user asked for. Only detectable by something
   *  holding the original prompt, which is the whole reason the conductor holds it. */
  | "intent_drift"
  /** The plan itself has become incoherent — steps contradict, acceptance criteria cannot
   *  be met, the premise turned out to be false. */
  | "incoherent";

export const HALT_CATEGORIES: ReadonlySet<string> = new Set<HaltCategory>([
  "safety", "security", "irrecoverable", "intent_drift", "incoherent",
]);

export type ContinuationVerdict =
  | {
    action: "continue";
    /** The message actually sent to the executor. May answer a question it asked. */
    message: string;
    /** One or two sentences for the transcript, aimed at the user. */
    rationale: string;
  }
  | {
    action: "halt";
    category: HaltCategory;
    reason: string;
    /** What a human would have to do to make continuing safe. Empty when nothing would. */
    whatWouldUnblock: string;
  }
  | {
    action: "ask_user";
    question: string;
    why: string;
  };

/** Why a continuation decision is being made at all. The conductor is told this because the
 *  right answer genuinely differs — a question wants an answer, a crash wants a restatement. */
export type ContinuationTrigger =
  /** The executor asked something and is waiting. */
  | "executor_question"
  /** The host restarted mid-step; nothing is wrong, the thread was cut. */
  | "interrupted"
  /** The step failed and has retries left. */
  | "step_failed"
  /** The executor stopped without finishing and without asking anything. */
  | "stalled";

export interface ContinuationStepBrief {
  title: string;
  /** Trimmed hard — the conductor needs the shape of the work, not its full text. */
  detail?: string;
  acceptanceCriteria?: string;
  note?: string;
}

export interface ContinuationBrief {
  /** The user's own words, oldest first. Never paraphrased: the point is the original. */
  userPrompts: string[];
  planTitle: string;
  planSummary?: string;
  completed: ContinuationStepBrief[];
  /** The step the executor was on when this decision became necessary. */
  current?: ContinuationStepBrief;
  /** Steps not yet started, so a question about a later phase is answerable. */
  remaining: ContinuationStepBrief[];
  /** The executor's last message, verbatim, including any question. */
  executorLastMessage: string;
  trigger: ContinuationTrigger;
  /** How many times this step has already been attempted. */
  attempts: number;
  /** Anything the user has already been asked and answered during this run. */
  priorDecisions?: string[];
}

/** Ask the model. Injected so the whole conductor is testable without a provider. */
export interface ContinuationModel {
  decide(systemPrompt: string, userPrompt: string): Promise<string>;
}

const MAX_PROMPT_CHARS = 4000;
const MAX_STEP_CHARS = 400;
const MAX_LISTED_STEPS = 25;

function clip(value: string | undefined, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function renderSteps(label: string, steps: readonly ContinuationStepBrief[]): string {
  if (!steps.length) return `${label}: none.`;
  const shown = steps.slice(0, MAX_LISTED_STEPS);
  const lines = shown.map((step, index) => {
    const parts = [`  ${index + 1}. ${clip(step.title, 200)}`];
    if (step.acceptanceCriteria) parts.push(`     done when: ${clip(step.acceptanceCriteria, MAX_STEP_CHARS)}`);
    if (step.note) parts.push(`     note: ${clip(step.note, MAX_STEP_CHARS)}`);
    return parts.join("\n");
  });
  const omitted = steps.length - shown.length;
  if (omitted > 0) lines.push(`  … and ${omitted} more.`);
  return `${label}:\n${lines.join("\n")}`;
}

const TRIGGER_FRAMING: Record<ContinuationTrigger, string> = {
  executor_question:
    "The executing agent asked a question and is waiting. If the plan or the user's original "
    + "request answers it, answer it directly and let the work continue. Escalate only if the "
    + "answer genuinely is not derivable from what you have been given.",
  interrupted:
    "The extension host restarted mid-step. Nothing went wrong with the work itself — the "
    + "thread was cut. Restate what the step was doing so the executor can pick it up without "
    + "redoing what is already done.",
  step_failed:
    "The step failed and has retries left. Say specifically what should be different this time. "
    + "An identical retry is not worth sending.",
  stalled:
    "The executor stopped without finishing and without asking anything. Work out from its last "
    + "message whether it believes it is done, is confused, or ran out of room.",
};

export function buildContinuationSystemPrompt(): string {
  return [
    "You are the conductor for a long-running plan execution in the Blacksite VS Code extension.",
    "",
    "You are not doing the work. Another agent is. Your only job is to decide whether that work "
    + "should continue, and if so, to write the single message that continues it.",
    "",
    "You hold something the executing agent no longer reliably holds: the user's ORIGINAL words. "
    + "An executor many steps deep has compacted and summarized its way through the task and can "
    + "drift without noticing. Checking the work still against what was actually asked is the "
    + "main reason you exist.",
    "",
    "You have no tools. You cannot edit, run, or inspect anything. Decide from what you are given.",
    "",
    "Return exactly one JSON object and nothing else. One of:",
    "",
    '  {"action":"continue","message":"<what to send the executor>","rationale":"<1-2 sentences for the user>"}',
    '  {"action":"halt","category":"<safety|security|irrecoverable|intent_drift|incoherent>",'
    + '"reason":"<why this stops here>","whatWouldUnblock":"<what a human would have to do, or empty>"}',
    '  {"action":"ask_user","question":"<the specific question>","why":"<why only the user can answer>"}',
    "",
    "Rules for `continue`:",
    "- `message` is sent verbatim to the executor. Write it to them, not about them.",
    "- If they asked something, answer it. You have the whole plan, including steps they have "
    + "not reached; a question about a later phase is usually answerable right now.",
    "- Be specific about what to do next. 'Continue' on its own is never an acceptable message.",
    "- Do not re-delegate work the completed list shows is already done.",
    "",
    "Rules for `halt` — this ends the run, and the executor does not get a vote:",
    "- safety: continuing would destroy or corrupt something real.",
    "- security: credentials, secrets, permissions, or auth surface are involved.",
    "- irrecoverable: the next action cannot be undone (force push, migration, deploy, release).",
    "- intent_drift: what is about to happen is not what the user asked for. You are the only "
    + "one positioned to catch this. Use it.",
    "- incoherent: the plan contradicts itself, or its premise turned out to be false.",
    "",
    "Halt decisively when a halt is right. An unattended run that pushes through a real stop is "
    + "far worse than one that ends early and asks. But do not halt merely because a step is "
    + "hard, slow, or has failed once — that is what retries are for.",
    "",
    "Use `ask_user` when the decision is genuinely the user's and the run can wait for it: a "
    + "product judgment, a preference, a tradeoff the original prompt does not settle.",
  ].join("\n");
}

export function buildContinuationUserPrompt(brief: ContinuationBrief): string {
  const prompts = brief.userPrompts.length
    ? brief.userPrompts.map((prompt, index) => `  [${index + 1}] ${clip(prompt, MAX_PROMPT_CHARS)}`).join("\n")
    : "  (none recorded — treat the plan itself as the only statement of intent)";

  const sections = [
    "THE USER ORIGINALLY ASKED FOR (verbatim, oldest first):",
    prompts,
    "",
    `PLAN: ${clip(brief.planTitle, 200)}`,
    brief.planSummary ? `Summary: ${clip(brief.planSummary, 1000)}` : "",
    "",
    renderSteps("COMPLETED", brief.completed),
    "",
    brief.current
      ? `CURRENT STEP (attempt ${brief.attempts + 1}):\n  ${clip(brief.current.title, 200)}`
        + (brief.current.acceptanceCriteria ? `\n  done when: ${clip(brief.current.acceptanceCriteria, MAX_STEP_CHARS)}` : "")
        + (brief.current.detail ? `\n  detail: ${clip(brief.current.detail, MAX_STEP_CHARS)}` : "")
      : "CURRENT STEP: none — the executor is between steps.",
    "",
    renderSteps("NOT YET STARTED", brief.remaining),
    "",
  ];

  if (brief.priorDecisions?.length) {
    sections.push(
      "ALREADY DECIDED THIS RUN (do not ask again):",
      brief.priorDecisions.map((decision) => `  - ${clip(decision, 500)}`).join("\n"),
      "",
    );
  }

  sections.push(
    "THE EXECUTING AGENT'S LAST MESSAGE:",
    brief.executorLastMessage.trim() ? clip(brief.executorLastMessage, 6000) : "  (it produced nothing)",
    "",
    `WHY YOU ARE BEING ASKED: ${TRIGGER_FRAMING[brief.trigger]}`,
    "",
    "Return the JSON object now.",
  );

  return sections.filter((section) => section !== "").join("\n");
}

/**
 * Parse the conductor's reply.
 *
 * Every failure path returns a halt, never a continue. An unparseable verdict means we do not
 * know what the conductor decided, and "we do not know" must never resolve to "keep going
 * unattended" — that is precisely the case where an auto-continuation does damage. The cost of
 * being wrong in this direction is a run that stops and asks; in the other direction it is a
 * run that proceeds past a stop nobody sanctioned.
 */
export function parseContinuationVerdict(raw: string): ContinuationVerdict {
  const halt = (reason: string): ContinuationVerdict => ({
    action: "halt",
    category: "incoherent",
    reason,
    whatWouldUnblock: "Review the run and continue it by hand if it should proceed.",
  });

  const parsed = extractJsonObject(raw);
  if (!parsed) return halt("The conductor's reply could not be read as a decision, so the run stopped rather than guessing.");

  const action = typeof parsed.action === "string" ? parsed.action : "";

  if (action === "continue") {
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    // A conductor that returns `continue` with nothing to say has not made a decision. Sending
    // a bare "continue" is the exact behaviour this whole mechanism replaces.
    if (!message) return halt("The conductor chose to continue but supplied no instruction, which is not a usable decision.");
    return {
      action: "continue",
      message,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : "",
    };
  }

  if (action === "halt") {
    const category = typeof parsed.category === "string" && HALT_CATEGORIES.has(parsed.category)
      ? parsed.category as HaltCategory
      // An unrecognized category still halts. The category shapes how it is reported; it is
      // never the thing that decides whether the halt is honoured.
      : "incoherent";
    return {
      action: "halt",
      category,
      reason: typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "The conductor halted the run without giving a reason.",
      whatWouldUnblock: typeof parsed.whatWouldUnblock === "string" ? parsed.whatWouldUnblock.trim() : "",
    };
  }

  if (action === "ask_user") {
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    if (!question) return halt("The conductor escalated to the user without a question, so the run stopped.");
    return {
      action: "ask_user",
      question,
      why: typeof parsed.why === "string" ? parsed.why.trim() : "",
    };
  }

  return halt(`The conductor returned an unrecognized action (${action || "none"}), so the run stopped rather than guessing.`);
}

/**
 * Pull the first balanced JSON object out of a reply.
 *
 * Models fence their JSON, prepend a sentence, or do both. Scanning for a balanced object is
 * more forgiving than a fence regex and costs nothing here — but it is deliberately not a
 * repair pass: anything that is not actually an object still fails, and failing means halting.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1)) as unknown;
          return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Run one continuation decision end to end. */
export async function decideContinuation(
  model: ContinuationModel,
  brief: ContinuationBrief,
): Promise<ContinuationVerdict> {
  try {
    const raw = await model.decide(buildContinuationSystemPrompt(), buildContinuationUserPrompt(brief));
    return parseContinuationVerdict(raw);
  } catch (error) {
    // A provider outage is not permission to keep going.
    return {
      action: "halt",
      category: "incoherent",
      reason: `The conductor could not be reached (${error instanceof Error ? error.message : String(error)}), so the run stopped.`,
      whatWouldUnblock: "Retry once the provider is reachable.",
    };
  }
}
