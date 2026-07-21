import { describe, expect, it } from "vitest";
import { buildSystemPrompt, type WorkspaceSnapshot } from "../../src/workspace-context.js";

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
});
