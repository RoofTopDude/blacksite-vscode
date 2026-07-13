import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// The execution log is the only postmortem artifact for a crashed session, so a path that opens
// a session without telling the logger about it silently produces a log with no sessionId,
// provider, or model on any row. That is exactly how the checkpoint-resume path shipped: it
// rebuilt the session after a crash — the moment the log matters most — and every event it
// wrote was unattributable.
//
// The fix is structural: _createSession registers the session it builds, so a new call site
// cannot forget. What these tests pin is that the registration stays *inside* _createSession —
// hoisting it back out to the call sites is what reintroduces the bug.

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function readSource(file: string): string {
  return fs.readFileSync(path.join(SRC, file), "utf8");
}

/** Strip line comments so a commented-out call never counts as a real one. */
function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => !line.trim().startsWith("//"));
}

/** The body of `_createSession`, from its signature to the start of the next class member. */
function createSessionBody(source: string): string {
  const start = source.indexOf("private async _createSession(");
  expect(start, "chat-provider has no _createSession definition").toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n  private ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("telemetry coverage — every session is registered with the execution logger", () => {
  it("registers the session inside _createSession, so no call site can forget", () => {
    const body = createSessionBody(readSource("chat-provider.ts"));
    expect(
      codeLines(body).some((line) => line.includes("_logger.sessionStart(")),
      "_createSession no longer registers the session it builds — every call site is now free to " +
      "open a session whose events log with no sessionId/provider/model",
    ).toBe(true);
  });

  it("keeps registration out of the call sites, where it can be forgotten again", () => {
    const source = readSource("chat-provider.ts");
    const body = createSessionBody(source);
    const total = codeLines(source).filter((line) => line.includes("_logger.sessionStart(")).length;
    const inside = codeLines(body).filter((line) => line.includes("_logger.sessionStart(")).length;

    expect(
      total - inside,
      "a sessionStart call outside _createSession either double-logs the session or is a call site " +
      "re-taking a responsibility _createSession already owns",
    ).toBe(0);
  });

  it("keeps sessionStart's signature these tests depend on", () => {
    // If the signature changes, the checks above could pass while attributing nothing.
    expect(readSource("execution-logger.ts")).toContain("sessionStart(sessionId: string, model: string, provider: string)");
  });
});

// An AgentEvent variant added without a case in logEvent's switch would vanish from the readable
// log with no error at all. The real guard against that is the `const unhandled: never = event`
// default in execution-logger.ts, which `npm run compile` enforces — a type-level guard placed in
// this file would enforce nothing, because tsconfig.json only includes src/ and the suite is
// transpiled by esbuild without typechecking.
//
// These tests pin the two things the compiler cannot see: that the exhaustiveness guard is still
// present, and that the structured sink is written before the switch narrows the event.
const KNOWN_EVENTS = [
  "iteration_start", "text_delta", "thinking_delta", "usage_update", "runtime_state",
  "tool_call_start", "tool_call_result", "execution_diagnostic", "approval_pending",
  "approval_result", "question_card_pending", "question_card_result", "turn_complete",
  "error", "subagent_lane_start", "subagent_lane_event", "subagent_lane_complete",
];

describe("telemetry coverage — the logger renders every agent event", () => {
  it("keeps the compiler-enforced exhaustiveness guard on logEvent's switch", () => {
    // Delete this and a new event variant starts disappearing from the log silently.
    expect(readSource("execution-logger.ts")).toContain("const unhandled: never = event");
  });

  it("has a logEvent case for every known AgentEvent variant", () => {
    const handled = new Set(
      [...readSource("execution-logger.ts").matchAll(/case\s+"([a-z_]+)"\s*:/g)].map((match) => match[1]!),
    );

    for (const type of KNOWN_EVENTS) {
      expect(handled.has(type), `execution-logger.logEvent has no case for the "${type}" event`).toBe(true);
    }
  });

  it("writes every event to the structured log before the switch narrows it", () => {
    // text_delta/thinking_delta are deliberately skipped in the human-readable channel, so the
    // jsonl sink must be written unconditionally or postmortems lose the model's output entirely.
    const logger = readSource("execution-logger.ts");
    const logEventBody = logger.slice(logger.indexOf("logEvent("), logger.indexOf("switch (event.type)"));
    expect(logEventBody).toContain("_writeStructured(");
  });
});
