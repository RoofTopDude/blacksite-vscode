/* Chat auto mode. The contract: routine operations are settled without a prompt, everything else
   escalates to the user — never a silent denial, never a standing grant — and a fixed set of
   operations (destructive, external services, sequences, protected paths) always asks. */

import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type ApprovalBatchCandidate, type ApprovalReviewRequest, type ApprovalReviewVerdict } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import {
  createAutoModeEditProvider,
  createAutoModeLspProvider,
  isProtectedPath,
  runtimeEditTargets,
  triageAutoApproval,
  triageAutoEdit,
} from "../../src/auto-approval-policy.js";
import { parseChatApprovalVerdict, reviewChatApproval, reviewChatApprovalGroups, buildChatApprovalReviewUserPrompt } from "../../src/continuation/approval-review.js";
import type { EditApprovalRequest } from "../../src/workspace-edit-applier.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("protected paths", () => {
  it("guards agent configuration, code that runs later, and credentials", () => {
    for (const path of [".git/hooks/pre-commit", ".blacksite/hooks.json", ".vscode/tasks.json", ".claude/skills/x/SKILL.md",
      ".agents/skills/a/SKILL.md", ".github/workflows/ci.yml", ".gitlab-ci.yml", ".husky/pre-push", ".devcontainer/devcontainer.json",
      ".env", "config/.env.production", ".npmrc", "certs/server.KEY", "home/id_ed25519", "Jenkinsfile", ".\\.vscode\\settings.json"]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
    for (const path of ["src/index.ts", ".github/CODEOWNERS", "docs/env.md", "package.json", "environment.ts", "keys.ts"]) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });

  it("reads the targets of runtime file tools", () => {
    expect(runtimeEditTargets("file_write", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(runtimeEditTargets("file_copy", { source: "a", destination: "b" })).toEqual(["b"]);
    expect(runtimeEditTargets("file_move", { source: "a", destination: "b" })).toEqual(["a", "b"]);
    expect(runtimeEditTargets("shell_run", { command: "x" })).toEqual([]);
  });
});

describe("triage", () => {
  const request = (over: Partial<ApprovalReviewRequest>) => ({ category: "command" as const, tier: "write", toolName: "shell_run", input: {}, ...over });

  it("never approves destructive operations, service mutations or sequences", () => {
    expect(triageAutoApproval(request({ tier: "destructive" })).action).toBe("escalate");
    expect(triageAutoApproval(request({ category: "service", tier: "network", toolName: "github_create_pr" })).action).toBe("escalate");
    expect(triageAutoApproval(request({ category: "sequence" })).action).toBe("escalate");
  });

  it("allows reversible workspace writes and escalates protected ones", () => {
    expect(triageAutoApproval(request({ category: "edit", toolName: "file_write", input: { path: "src/a.ts" } })).action).toBe("allow");
    expect(triageAutoApproval(request({ category: "edit", toolName: "file_write", input: { path: ".vscode/tasks.json" } })).action).toBe("escalate");
    expect(triageAutoApproval(request({ category: "edit", toolName: "file_write", input: {} })).action).toBe("escalate");
  });

  it("sends commands to the model reviewer", () => {
    expect(triageAutoApproval(request({})).action).toBe("review");
  });

  it("applies ordinary editor edits and escalates destructive, unpreviewable or protected ones", () => {
    const base: EditApprovalRequest = { summary: "s", fileCount: 1, paths: ["src/a.ts"] };
    expect(triageAutoEdit(base).action).toBe("allow");
    expect(triageAutoEdit({ ...base, destructive: true }).action).toBe("escalate");
    expect(triageAutoEdit({ ...base, unpreviewableCommand: "cmd" }).action).toBe("escalate");
    expect(triageAutoEdit({ ...base, paths: ["src/a.ts", ".git/config"] }).action).toBe("escalate");
    expect(triageAutoEdit({ ...base, paths: [] }).action).toBe("escalate");
  });
});

describe("auto-mode edit routing", () => {
  function wrapped(mode: "ask" | "auto") {
    const seen: Array<Record<string, unknown>> = [];
    const delegate = {
      applyEdit: vi.fn(async (_input: unknown, opts: Record<string, unknown>) => { seen.push(opts); return { ok: true as const, path: "a", replacements: 1 }; }),
      applyBatchEdits: vi.fn(),
      applyJsonEdit: vi.fn(),
    };
    const escalate = vi.fn(async () => "apply" as const);
    const provider = createAutoModeEditProvider(delegate as any, { mode: () => mode, escalate });
    return { provider, seen, escalate };
  }
  const input = { path: "a", oldString: "x", newString: "y" };

  it("changes nothing in ask mode or under an Allow-all grant", async () => {
    const ask = wrapped("ask");
    await ask.provider.applyEdit(input, { autoApprove: false });
    expect(ask.seen[0]).toEqual({ autoApprove: false });
    const granted = wrapped("auto");
    await granted.provider.applyEdit(input, { autoApprove: true });
    expect(granted.seen[0]).toEqual({ autoApprove: true });
  });

  it("applies routine edits itself and hands the rest to the user with a reason", async () => {
    const { provider, seen, escalate } = wrapped("auto");
    await provider.applyEdit(input, { autoApprove: false });
    const approve = seen[0]!["approvalProvider"] as (r: EditApprovalRequest) => Promise<string | null>;
    const shouldPreview = seen[0]!["shouldPreview"] as (r: EditApprovalRequest) => boolean;
    const routine: EditApprovalRequest = { summary: "edit", fileCount: 1, paths: ["src/a.ts"] };
    expect(await approve(routine)).toBe("apply");
    expect(shouldPreview(routine)).toBe(false);
    expect(escalate).not.toHaveBeenCalled();

    const guarded: EditApprovalRequest = { summary: "edit", fileCount: 1, paths: [".vscode/launch.json"] };
    expect(shouldPreview(guarded)).toBe(true);
    await approve(guarded);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining("Auto mode: .vscode/launch.json is a protected path") }));
  });

  it("routes language-server edits the same way", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const lsp = createAutoModeLspProvider({ dispatch: vi.fn(async (_op, _p, ctx) => { seen.push(ctx as any); return { ok: true } as any; }) }, { mode: () => "auto", escalate: vi.fn() });
    await lsp.dispatch("rename", {}, { autoApprove: false });
    expect(typeof seen[0]!["approvalProvider"]).toBe("function");
  });
});

describe("chat approval reviewer", () => {
  it("allows only with a stated reason and escalates everything else", () => {
    expect(parseChatApprovalVerdict('{"action":"allow","reason":"runs the tests the user asked for"}')).toEqual({ action: "allow", reason: "runs the tests the user asked for" });
    expect(parseChatApprovalVerdict('{"action":"allow"}').action).toBe("escalate");
    expect(parseChatApprovalVerdict('{"action":"deny","reason":"x"}').action).toBe("escalate");
    expect(parseChatApprovalVerdict("I think it's fine").action).toBe("escalate");
    expect(parseChatApprovalVerdict('prefix {"action":"escalate","reason":"pushes to main"} suffix')).toEqual({ action: "escalate", reason: "pushes to main" });
  });

  it("escalates when the model cannot be reached", async () => {
    const verdict = await reviewChatApproval({ decide: async () => { throw new Error("offline"); } }, { userPrompts: [], toolName: "shell_run", tier: "write", description: "npm test" });
    expect(verdict).toEqual({ action: "escalate", reason: expect.stringContaining("offline") });
  });

  it("puts the user's own words and the exact operation in front of the reviewer", () => {
    const prompt = buildChatApprovalReviewUserPrompt({ userPrompts: ["run the unit tests"], toolName: "shell_run", tier: "write", description: "Run `npm test`", unrecognizedCommand: true });
    expect(prompt).toContain("run the unit tests");
    expect(prompt).toContain("Run `npm test`");
    expect(prompt).toContain("unrecognized executable");
  });

  it("starts tool groups in parallel and maps mixed decisions to their exact call IDs", async () => {
    const started: string[] = [];
    const pending: Array<(value: string) => void> = [];
    const modelFactory = () => ({ decide: async (_system: string, prompt: string) => {
      started.push(prompt);
      return new Promise<string>((resolve) => pending.push(resolve));
    } });
    const calls = [
      { toolCallId: "a", toolName: "mcp_call_tool", input: { serverId: "files", toolName: "search", args: { query: "a" } } },
      { toolCallId: "b", toolName: "mcp_call_tool", input: { serverId: "files", toolName: "search", args: { query: "b" } } },
      { toolCallId: "c", toolName: "shell_run", input: { command: "npm test" } },
      { toolCallId: "d", toolName: "mcp_call_tool", input: { serverId: "files", toolName: "write", args: { path: "a" } } },
    ];
    const reviewing = reviewChatApprovalGroups(modelFactory, ["search and test"], calls);
    expect(started).toHaveLength(3);
    expect(started[0]).toContain('ID "a"');
    expect(started[0]).toContain('ID "b"');
    expect(started[1]).toContain('ID "c"');
    expect(started[2]).toContain('ID "d"');
    pending[0]!(JSON.stringify({ decisions: [
      { toolCallId: "a", action: "allow", reason: "search requested" },
      { toolCallId: "b", action: "escalate", reason: "ambiguous search" },
    ] }));
    pending[1]!(JSON.stringify({ decisions: [{ toolCallId: "c", action: "allow", reason: "tests requested" }] }));
    pending[2]!(JSON.stringify({ decisions: [{ toolCallId: "d", action: "escalate", reason: "write unclear" }] }));
    expect(await reviewing).toEqual({
      a: { action: "allow", reason: "search requested" },
      b: { action: "escalate", reason: "ambiguous search" },
      c: { action: "allow", reason: "tests requested" },
      d: { action: "escalate", reason: "write unclear" },
    });
  });

  it("escalates an omitted or duplicated call instead of borrowing a group decision", async () => {
    const calls = [
      { toolCallId: "a", toolName: "shell_run", input: { command: "one" } },
      { toolCallId: "b", toolName: "shell_run", input: { command: "two" } },
    ];
    const result = await reviewChatApprovalGroups(() => ({ decide: async () => JSON.stringify({ decisions: [
      { toolCallId: "a", action: "allow", reason: "yes" },
      { toolCallId: "a", action: "allow", reason: "yes" },
    ] }) }), [], calls);
    expect(result.a.action).toBe("escalate");
    expect(result.b.action).toBe("escalate");
  });
});

describe("AgentSession with an approval reviewer", () => {
  function setup(reviewer: (r: ApprovalReviewRequest) => Promise<{ action: "allow" | "escalate"; reason: string } | null>, calls: ToolUseBlock[], batchReviewer?: (calls: ApprovalBatchCandidate[]) => Promise<Record<string, ApprovalReviewVerdict>>, tierFor?: (command: string) => string, descriptionFor?: (command: string) => string) {
    const executed: string[] = [];
    const runtime = {
      handleMessage: vi.fn(async (m: { payload: Record<string, unknown> }) => {
        if (m.payload["confirmed"] !== true) return { result: { ok: true, requiresConfirmation: true, tier: tierFor?.(String(m.payload["command"])) ?? "write", description: descriptionFor?.(String(m.payload["command"])) ?? `Run ${String(m.payload["command"])}` } };
        executed.push(String(m.payload["command"]));
        return { result: { ok: true, stdout: "ok" } };
      }),
    };
    const approvalProvider = vi.fn(async () => "allow" as const);
    let served = false;
    const scripted = new ScriptedProviderSession(() => {
      if (served) return { text: "done", stopReason: "end_turn", usage };
      served = true;
      return { toolCalls: calls, stopReason: "tool_use", usage };
    });
    const reviewerSpy = vi.fn(reviewer);
    const session = new AgentSession({
      apiKey: "k", model: "claude-sonnet-4-6", systemPrompt: "s", workspaceRoot: "C:/w", provider: "anthropic",
      runtime: runtime as any, context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
      checkpointingEnabled: false, maxIterations: 6, approvalProvider, approvalReviewer: reviewerSpy, approvalReviewerBatch: batchReviewer,
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    });
    return { session, executed, approvalProvider, reviewerSpy };
  }
  async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }
  const run = (id: string, command: string): ToolUseBlock => ({ type: "tool_use", id, name: "shell_run", input: { command } });

  it("runs an allowed call without prompting, once per call", async () => {
    const { session, executed, approvalProvider, reviewerSpy } = setup(async () => ({ action: "allow", reason: "tests requested" }), [run("a", "npm"), run("b", "npm")]);
    const events = await drain(session.send("run the tests"));
    expect(approvalProvider).not.toHaveBeenCalled();
    expect(executed).toEqual(["npm", "npm"]);
    // One-shot: the second identical call was reviewed again rather than covered by a grant.
    expect(reviewerSpy).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "approval_review", toolCallId: "a", verdict: "allowed", reason: "tests requested" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "approval_result", toolCallId: "a", decision: "allow" }));
  });

  it("uses distinct decisions from one submitted batch while executing calls in order", async () => {
    const batchReviewer = vi.fn(async (calls: ApprovalBatchCandidate[]) => Object.fromEntries(calls.map((call) => [
      call.toolCallId, { action: call.toolCallId === "a" ? "allow" : "escalate", reason: call.toolCallId === "a" ? "requested" : "needs user" },
    ])) as Record<string, ApprovalReviewVerdict>);
    const { session, executed, reviewerSpy, approvalProvider } = setup(async () => ({ action: "allow", reason: "fallback" }), [run("a", "one"), run("b", "two")], batchReviewer);
    const events = await drain(session.send("run one and two"));
    expect(batchReviewer).toHaveBeenCalledTimes(1);
    expect(batchReviewer.mock.calls[0]![0].map((call) => call.toolCallId)).toEqual(["a", "b"]);
    expect(reviewerSpy).not.toHaveBeenCalled();
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(["one", "two"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "approval_review", toolCallId: "b", verdict: "escalated" }));
  });

  it("does not use a provisional allow for a destructive runtime classification", async () => {
    const batchReviewer = vi.fn(async () => ({ a: { action: "allow" as const, reason: "provisional" }, b: { action: "allow" as const, reason: "provisional" } }));
    const { session, reviewerSpy, approvalProvider } = setup(async () => ({ action: "escalate", reason: "destructive" }), [run("a", "safe"), run("b", "danger")], batchReviewer, (command) => command === "danger" ? "destructive" : "write");
    await drain(session.send("go"));
    expect(reviewerSpy).toHaveBeenCalledTimes(1);
    expect(reviewerSpy.mock.calls[0]![0]).toEqual(expect.objectContaining({ toolCallId: "b", tier: "destructive" }));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
  });

  it("reviews a command again when the runtime discovers access outside the workspace", async () => {
    const batchReviewer = vi.fn(async () => ({
      a: { action: "allow" as const, reason: "provisional" },
      b: { action: "allow" as const, reason: "provisional" },
    }));
    const { session, reviewerSpy, approvalProvider } = setup(
      async () => ({ action: "escalate", reason: "external path" }),
      [run("a", "local"), run("b", "external")], batchReviewer, undefined,
      (command) => command === "external"
        ? "Run external — reaches outside the workspace: C:/private (write operation)"
        : "Run local (write operation)",
    );
    await drain(session.send("run both"));
    expect(reviewerSpy).toHaveBeenCalledTimes(1);
    expect(reviewerSpy.mock.calls[0]![0]).toEqual(expect.objectContaining({
      toolCallId: "b", description: expect.stringContaining("reaches outside the workspace"),
    }));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
  });

  it("checks the resolved MCP destination again before using a batch allow", async () => {
    const mcpCall = (id: string): ToolUseBlock => ({ type: "tool_use", id, name: "mcp_call_tool", input: { serverId: "files", toolName: "search", args: { query: id } } });
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex > 0
      ? { text: "done", stopReason: "end_turn", usage }
      : { toolCalls: [mcpCall("a"), mcpCall("b")], stopReason: "tool_use", usage });
    const batchReviewer = vi.fn(async () => ({
      a: { action: "allow" as const, reason: "search requested" },
      b: { action: "allow" as const, reason: "search requested" },
    }));
    const reviewer = vi.fn(async () => ({ action: "escalate" as const, reason: "destination changed" }));
    const approvalProvider = vi.fn(async () => "allow" as const);
    const runtime = { handleMessage: vi.fn(async () => ({ result: {
      ok: true, requiresConfirmation: true, tier: "network",
      description: "Connect to the configured MCP server at https://other.example and call the tool 'search'",
    } })) };
    const session = new AgentSession({
      apiKey: "k", model: "claude-sonnet-4-6", systemPrompt: "s", workspaceRoot: "C:/w", provider: "anthropic",
      runtime: runtime as any, context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
      checkpointingEnabled: false, maxIterations: 6, approvalProvider,
      approvalReviewer: reviewer, approvalReviewerBatch: batchReviewer,
      mcpServerProvider: async () => ({ ok: true, server: { url: "https://files.example/api" } as any }),
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    });
    await drain(session.send("search files"));
    expect(batchReviewer).toHaveBeenCalledTimes(1);
    expect(batchReviewer.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: "a", description: "Connect to the configured MCP server at https://files.example and call the tool 'search'" }),
    ]));
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(approvalProvider).toHaveBeenCalledTimes(2);
  });

  it("asks the user after an escalation, with the review recorded first", async () => {
    const { session, approvalProvider } = setup(async () => ({ action: "escalate", reason: "pushes to a remote" }), [run("a", "git")]);
    const events = await drain(session.send("push it"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    const reviewAt = events.findIndex((e) => e.type === "approval_review");
    const pendingAt = events.findIndex((e) => e.type === "approval_pending");
    expect(reviewAt).toBeGreaterThanOrEqual(0);
    expect(pendingAt).toBeGreaterThan(reviewAt);
  });

  it("leaves the ordinary path alone when the reviewer abstains (ask mode)", async () => {
    const { session, approvalProvider } = setup(async () => null, [run("a", "npm")]);
    const events = await drain(session.send("go"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "approval_review")).toBe(false);
  });
});

describe("recorded user prompts", () => {
  it("records what the user typed, not harness turns, and survives a restore", async () => {
    const scripted = new ScriptedProviderSession(() => ({ text: "ok", stopReason: "end_turn", usage }));
    const make = () => new AgentSession({
      apiKey: "k", model: "claude-sonnet-4-6", systemPrompt: "s", workspaceRoot: "C:/w", provider: "anthropic",
      runtime: { handleMessage: vi.fn() } as any, context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
      checkpointingEnabled: false, memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    });
    const session = make();
    for await (const _ of session.send("Referenced file `a.ts`:\n```ts\nx\n```\n\nfix the bug", { userText: "fix the bug" })) void _;
    for await (const _ of session.send("[Automatic plan continuation]\nkeep going")) void _;
    expect(session.userPrompts).toEqual(["fix the bug"]);
    const restored = make();
    restored.restoreState({ ...session.exportState(true), messages: [] });
    expect(restored.userPrompts).toEqual(["fix the bug"]);
  });
});
