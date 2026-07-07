import { describe, expect, it } from "vitest";
import {
  appendBedrockWorkspaceContextTail,
  appendWorkspaceContextTail,
  filterConfiguredServiceTools,
  toBedrockMessages,
  withBedrockRollingCacheBreakpoint,
  withRollingCacheBreakpoint,
} from "../../src/agent-session.js";
import {
  buildStaticSystemPrompt,
  buildWorkspaceContextBlock,
  buildSystemPrompt,
  type WorkspaceSnapshot,
} from "../../src/workspace-context.js";
import type { AgentMessage, ContentBlock } from "../../src/agent-loop-contract.js";

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

describe("static / volatile system-prompt split", () => {
  it("keeps live workspace state out of the cacheable static prompt", () => {
    const staticPrompt = buildStaticSystemPrompt();
    expect(staticPrompt).toContain("## Your toolset");
    // The volatile facts must NOT be baked into the cached prefix…
    expect(staticPrompt).not.toContain("Workspace root:");
    expect(staticPrompt).not.toContain("Diagnostics:");
    // …but it should tell the model where the live state comes from.
    expect(staticPrompt).toContain("Current workspace state");
  });

  it("puts live workspace facts in the refreshable block under a clear header", () => {
    const block = buildWorkspaceContextBlock(snapshot({
      gitStatusSummary: "Branch: main | Staged: 1",
      diagnosticSummary: "2 error(s)",
      diagnosticDetails: "src/x.ts:3 — boom",
    }));
    expect(block).toContain("# Current workspace state");
    expect(block).toContain("Refreshed each turn");
    expect(block).toContain("Workspace root: /ws");
    expect(block).toContain("Branch: main");
    expect(block).toContain("2 error(s)");
  });

  it("wrapper buildSystemPrompt still carries both halves (delegated-lane path)", () => {
    const full = buildSystemPrompt(snapshot({ gitStatusSummary: "Branch: dev" }));
    expect(full).toContain("## Your toolset");     // static
    expect(full).toContain("Branch: dev");         // volatile
  });
});

describe("appendWorkspaceContextTail — cache-preserving tail injection", () => {
  it("appends the block AFTER the rolling cache breakpoint so the prefix stays cached", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
    ];
    const breakpointed = withRollingCacheBreakpoint(messages);
    const out = appendWorkspaceContextTail(breakpointed, "# Current workspace state\nBranch: main");

    const lastBlocks = out[out.length - 1]!.content as ContentBlock[];
    const ctxBlock = lastBlocks[lastBlocks.length - 1]!;
    const priorBlock = lastBlocks[lastBlocks.length - 2]!;

    // The context block is last and is NOT cached (it changes every turn)…
    expect(ctxBlock.type).toBe("text");
    expect((ctxBlock as { text: string }).text).toContain("Branch: main");
    expect((ctxBlock as { cache_control?: unknown }).cache_control).toBeUndefined();
    // …while the cache breakpoint remains on the preceding (stable) block.
    expect((priorBlock as { cache_control?: unknown }).cache_control).toBeDefined();
  });

  it("does not mutate the input array or its messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const before = JSON.stringify(messages);
    const out = appendWorkspaceContextTail(messages, "ctx");
    expect(JSON.stringify(messages)).toBe(before);
    expect(out).not.toBe(messages);
    expect((out[0]!.content as ContentBlock[]).length).toBe(2);
  });

  it("is a no-op for an empty context block", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
    expect(appendWorkspaceContextTail(messages, "")).toBe(messages);
    expect(appendWorkspaceContextTail(messages, "   ")).toBe(messages);
  });

  it("appends a fresh user turn if the last message is not a user turn", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: "thinking" }];
    const out = appendWorkspaceContextTail(messages, "ctx");
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe("user");
  });
});

describe("appendBedrockWorkspaceContextTail — cache-preserving tail injection (Converse)", () => {
  const messages: AgentMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
  ];

  it("appends the block AFTER the cachePoint so the message-history prefix stays cached", () => {
    const cached = withBedrockRollingCacheBreakpoint(toBedrockMessages(messages));
    const out = appendBedrockWorkspaceContextTail(cached, "# Current workspace state\nBranch: main");

    const lastBlocks = out[out.length - 1]!.content;
    const ctxBlock = lastBlocks[lastBlocks.length - 1]!;
    const priorBlock = lastBlocks[lastBlocks.length - 2]!;

    // The volatile block is the final block…
    expect((ctxBlock as { text?: string }).text).toContain("Branch: main");
    // …and sits PAST the cachePoint, which must be the block immediately before it — otherwise
    // the per-turn block would land inside the cached prefix and miss the cache every turn.
    expect((priorBlock as { cachePoint?: unknown }).cachePoint).toBeDefined();
  });

  it("is a no-op for an empty context block and never mutates the input", () => {
    const converted = toBedrockMessages(messages);
    const before = JSON.stringify(converted);
    expect(appendBedrockWorkspaceContextTail(converted, "   ")).toBe(converted);
    const out = appendBedrockWorkspaceContextTail(converted, "ctx");
    expect(JSON.stringify(converted)).toBe(before);
    expect(out).not.toBe(converted);
  });

  it("leaves a non-user trailing message untouched (Converse alternation guard)", () => {
    const assistantLast = toBedrockMessages([{ role: "assistant", content: "thinking" }]);
    expect(appendBedrockWorkspaceContextTail(assistantLast, "ctx")).toBe(assistantLast);
  });
});

describe("filterConfiguredServiceTools — capability gating", () => {
  it("advertises no service tools when nothing is configured", () => {
    expect(filterConfiguredServiceTools(new Set())).toHaveLength(0);
  });

  it("advertises only the configured provider families", () => {
    const tools = filterConfiguredServiceTools(new Set(["github"]));
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.name.startsWith("github_"))).toBe(true);
    expect(tools.some((t) => t.name.startsWith("gitlab_"))).toBe(false);
  });

  it("advertises everything when the set is undefined (back-compat)", () => {
    const all = filterConfiguredServiceTools(undefined);
    const both = filterConfiguredServiceTools(new Set(["github", "gitlab", "jira", "confluence", "salesforce"]));
    expect(all.length).toBe(both.length);
    expect(all.length).toBeGreaterThan(0);
  });
});
