import { describe, expect, it } from "vitest";
import { buildSystemPrompt, type WorkspaceSnapshot } from "../../src/workspace-context.js";
import { buildDelegatedSystemPrompt } from "../../src/chat/subagent-lanes.js";

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceRoot: "/ws",
    allRoots: ["/ws"],
    openFiles: [],
    diagnosticSummary: "No diagnostics",
    diagnosticDetails: "",
    gitStatusSummary: "",
    baseContext: "",
    structuredBaseContext: "",
    projectMemory: "",
    uiPreferenceSummary: "",
    planningSummary: "",
    ticketSummary: "",
    ...overrides,
  };
}

describe("buildSystemPrompt capability map", () => {
  const prompt = buildSystemPrompt(snapshot());

  it("sets the harness-aligned framing", () => {
    expect(prompt).toContain("one system with this harness");
  });

  it("documents each real tool family accurately", () => {
    expect(prompt).toContain("## Your toolset");
    // Code intelligence
    expect(prompt).toContain("code_symbols");
    expect(prompt).toContain("code_navigate");
    expect(prompt).toContain("code_rename");
    // Diagnostics & tests
    expect(prompt).toContain("code_diagnostics");
    expect(prompt).toContain("test_run");
    expect(prompt).toContain("report_problems");
    // Delegation
    expect(prompt).toContain("subagent_spawn");
    expect(prompt).toContain("cannot see this conversation");
    // Codebase Map
    expect(prompt).toContain("map_overview");
    expect(prompt).toContain("map_note_add");
    expect(prompt).toContain("map_note_list");
    expect(prompt).toContain("map_note_update");
    expect(prompt).toContain("map_note_remove");
    // Data workbench (read-only + preview writes)
    expect(prompt).toContain("db_run_read_query");
    expect(prompt).toContain("db_preview_write_query");
    // Integrations + version control
    expect(prompt).toContain("mcp_call_tool");
    expect(prompt).toContain("worktree_op");
  });

  it("documents the whole ticket family, not just filing", () => {
    expect(prompt).toContain("Work queue (tickets)");
    for (const tool of [
      "ticket_file", "ticket_list", "ticket_get", "ticket_comment",
      "ticket_update", "ticket_next", "ticket_promote", "ticket_sweep",
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it("teaches the ticket/plan/todo split and who closes a ticket", () => {
    expect(prompt).toContain("A TICKET is a durable outcome");
    expect(prompt).toContain("Closing is the user's call");
    expect(prompt).toContain("call ticket_next rather than picking from the queue summary by eye");
  });

  it("does not over-promise: capabilities are gated on tool availability", () => {
    expect(prompt).toContain("if a tool is not in your list");
  });

  it("still includes existing planning guidance", () => {
    expect(prompt).toContain("on_hold");
  });

  it("teaches proportionate, evidence-based use of plans", () => {
    expect(prompt).toContain("Use plans deliberately, not ceremonially");
    expect(prompt).toContain("Make plans useful execution contracts");
  });

  it("nudges the agent to narrate progress during longer tool sequences", () => {
    expect(prompt).toContain("narrate briefly between steps");
    expect(prompt).toContain("reads as stuck");
  });

  it("documents code_replace/code_replace_batch/json_edit alongside the other precise-edit tools", () => {
    expect(prompt).toContain("code_replace");
    expect(prompt).toContain("code_replace_batch");
    expect(prompt).toContain("json_edit");
  });

  it("nudges surveying existing patterns and capturing design rationale before/after architectural decisions", () => {
    expect(prompt).toContain("existing analogous implementations");
    expect(prompt).toContain("phaseRationale");
  });

  it("sets an advanced, project-adaptive quality bar for visual preference questions", () => {
    expect(prompt).toContain("Ask at the altitude of the real decision");
    expect(prompt).toContain("Ground every visual question in the actual project");
    expect(prompt).toContain("generic dashboard aesthetic");
    expect(prompt).toContain("Do not present the same safe middle-ground design under several labels");
  });

  it("explicitly supports high-fidelity 2D and 3D preview directions", () => {
    expect(prompt).toContain("Canvas 2D");
    expect(prompt).toContain("WebGL/WebGPU");
    expect(prompt).toContain("geometry, camera, lighting, materials, depth, motion");
    expect(prompt).toContain("re-render until the evidence is genuinely decision-ready");
  });

  it("teaches evidence-driven adaptation to the live environment", () => {
    expect(prompt).toContain("Operate in evidence loops");
    expect(prompt).toContain("Reconcile the environment");
    expect(prompt).toContain("strategy signal");
  });

  it("defines request profiles as specializations of the stable core contract", () => {
    expect(prompt).toContain("Active request profile");
    expect(prompt).toContain("never overrides the user's explicit scope");
  });

  it("treats repository instructions and the architecture index as first-class context", () => {
    expect(prompt).toContain("Project instructions");
    expect(prompt).toContain("closest scoped instruction file wins");
    expect(prompt).toContain("start broad or architectural work with map_overview");
  });

  it("teaches the Codebase Map workflow and note-taking strategy", () => {
    expect(prompt).toContain("Codebase Map: usage & note-taking");
    expect(prompt).toContain("After an edit, a note is required");
    expect(prompt).toContain("Refine, don't duplicate");
    expect(prompt).toContain("Prune what you invalidate");
  });

  /* Concrete behaviours rather than exhortation: each habit is checkable in a transcript. */
  it("teaches engineering judgement as concrete, checkable habits", () => {
    expect(prompt).toContain("## Engineering judgement");
    expect(prompt).toContain("Define done before the first edit");
    expect(prompt).toContain("Find the cause, not the symptom");
    expect(prompt).toContain("Follow a change to its consumers");
    expect(prompt).toContain("Never make a check pass by weakening it");
    expect(prompt).toContain("should fail without the fix");
    expect(prompt).toContain("never present unverified work as done");
  });

  it("puts judgement ahead of the tool mechanics it governs", () => {
    expect(prompt.indexOf("## Engineering judgement")).toBeLessThan(prompt.indexOf("## Guidelines"));
  });
});

describe("buildDelegatedSystemPrompt", () => {
  it("asks a lane to separate what it verified from what it inferred", () => {
    const lane = buildDelegatedSystemPrompt("BASE", { complexity: "standard", maxToolRounds: 10, maxRuntimeSeconds: 60, idleTimeoutSeconds: 30 } as never);
    expect(lane).toContain("separate what you verified (and how) from what you inferred");
    expect(lane.endsWith("BASE")).toBe(true);
  });
});
