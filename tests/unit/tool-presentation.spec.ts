import { describe, expect, it } from "vitest";
import {
  toolResultPresentation,
  toolInputPreview,
  toolIntentPhrase,
  toolActivityKind,
  parseToolResult,
  formatDetailValue,
} from "../../src/webview/react/lib/tool-presentation.js";

/* ── parseToolResult ──────────────────────────────────────────────────────── */

describe("parseToolResult", () => {
  it("returns non-string values unchanged", () => {
    const obj = { ok: true };
    expect(parseToolResult(obj)).toBe(obj);
    expect(parseToolResult(null)).toBeNull();
    expect(parseToolResult(42)).toBe(42);
  });

  it("parses valid JSON strings", () => {
    expect(parseToolResult('{"ok":true}')).toEqual({ ok: true });
    expect(parseToolResult("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns the raw string when JSON is invalid", () => {
    expect(parseToolResult("not json")).toBe("not json");
  });
});

/* ── formatDetailValue ────────────────────────────────────────────────────── */

describe("formatDetailValue", () => {
  it("returns empty label for null/undefined", () => {
    const { text, empty } = formatDetailValue(null);
    expect(empty).toBe(true);
    expect(text).toBe("No data");
  });

  it("returns custom empty label", () => {
    expect(formatDetailValue(null, "Nothing here").text).toBe("Nothing here");
  });

  it("returns string value as-is", () => {
    const { text, empty } = formatDetailValue("hello world");
    expect(text).toBe("hello world");
    expect(empty).toBe(false);
  });

  it("pretty-prints objects", () => {
    const { text } = formatDetailValue({ a: 1 });
    expect(text).toContain('"a": 1');
  });

  it("truncates very long values", () => {
    const long = "x".repeat(13000);
    const { text } = formatDetailValue(long);
    expect(text.length).toBeLessThan(12100);
    expect(text.includes("truncated")).toBe(true);
  });
});

/* ── toolResultPresentation ───────────────────────────────────────────────── */

describe("toolResultPresentation", () => {
  it("returns fail state for result with top-level error field", () => {
    const p = toolResultPresentation("file_read", { error: "Not found" });
    expect(p.state).toBe("fail");
    expect(p.label).toBe("Failed");
    expect(p.preview).toContain("Not found");
  });

  it("handles file_read result", () => {
    const p = toolResultPresentation("file_read", { path: "src/foo.ts", sizeBytes: 1024, content: "hello" });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("foo.ts");
    expect(p.preview).toContain("KB");
  });

  it("handles file_write result", () => {
    const p = toolResultPresentation("file_write", { path: "src/bar.ts", bytesWritten: 2048 });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("bar.ts");
  });

  it("handles file_edit result", () => {
    const p = toolResultPresentation("file_edit", { path: "src/baz.ts", replacements: 3 });
    expect(p.state).toBe("ok");
    expect(p.preview).toContain("3 replacements");
  });

  it("handles file_edit_batch result by count", () => {
    const p = toolResultPresentation("file_edit_batch", { edits: 5, files: 2 });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("5 edits");
    expect(p.preview).toContain("2 files");
  });

  it("handles file_edit_batch result with applied array", () => {
    const p = toolResultPresentation("file_edit_batch", { applied: ["a", "b", "c"] });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("3 edits");
  });

  it("handles shell_run success", () => {
    const p = toolResultPresentation("shell_run", { ok: true, exitCode: 0, stdout: "output", cwd: "/app" });
    expect(p.state).toBe("ok");
    expect(p.label).toBe("Command finished");
  });

  it("handles shell_run failure by exit code", () => {
    const p = toolResultPresentation("shell_run", { ok: false, exitCode: 1, stderr: "error msg" });
    expect(p.state).toBe("fail");
    expect(p.label).toBe("Exit 1");
  });

  it("handles shell_run spawn failure (command not found) as a failure, not a success", () => {
    const p = toolResultPresentation("shell_run", { ok: true, exitCode: null, stderr: "spawn node ENOENT", timedOut: false, cwd: "/app" });
    expect(p.state).toBe("fail");
    expect(p.label).toBe("Failed to start");
  });

  it("does not treat a timeout kill (also exitCode: null) as a spawn failure", () => {
    const p = toolResultPresentation("shell_run", { ok: true, exitCode: null, stdout: "partial", timedOut: true, cwd: "/app" });
    expect(p.label).not.toBe("Failed to start");
    expect(p.preview).toContain("timed out");
  });

  it("handles git_op commit result", () => {
    const p = toolResultPresentation("git_op", { data: { hash: "abc12345", summary: "feat: add feature" } });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("Commit abc12345");
  });

  it("handles git_op branch list", () => {
    const p = toolResultPresentation("git_op", {
      data: { branches: [{ name: "main", current: true }, { name: "dev", current: false }] },
    });
    // countLabel uses simple +s pluralization: "branch" → "branchs"
    expect(p.label).toContain("2 branch");
    expect(p.state).toBe("ok");
  });

  it("handles git_op status", () => {
    const p = toolResultPresentation("git_op", {
      data: { branch: "main", staged: ["a.ts"], unstaged: [], untracked: [] },
    });
    expect(p.label).toBe("main");
    expect(p.preview).toContain("1 staged");
  });

  it("handles code_symbols result", () => {
    const p = toolResultPresentation("code_symbols", {
      scope: "workspace", query: "MyClass",
      symbols: [{ name: "MyClass", kind: "class" }],
    });
    expect(p.label).toContain("1 symbol");
  });

  it("handles code_diagnostics with errors", () => {
    const p = toolResultPresentation("code_diagnostics", {
      counts: { error: 2, warning: 1 },
      problems: [{ message: "Type error" }],
    });
    expect(p.state).toBe("fail");
    expect(p.label).toContain("2 errors");
  });

  it("surfaces partial hierarchy graphs and uncertain resource mutations", () => {
    const hierarchy = toolResultPresentation("code_hierarchy", {
      kind: "callees",
      results: [{ symbol: "child", path: "src/a.ts", line: 2 }],
      graph: { requestedDepth: 3, status: "partial", nodes: [{}, {}], edges: [{}] },
    });
    expect(hierarchy.state).toBe("warn");
    expect(hierarchy.preview).toContain("2 nodes");
    expect(hierarchy.preview).toContain("partial");

    const mutation = toolResultPresentation("code_actions", {
      title: "Move file",
      mutation: {
        status: "uncertain",
        saved: false,
        resourceOperations: [{ kind: "rename" }],
        commands: [{ id: "move.run", status: "completed" }],
      },
    });
    expect(mutation.state).toBe("warn");
    expect(mutation.preview).toContain("1 resource op");
    expect(mutation.preview).toContain("save unconfirmed");
  });

  it("surfaces a notice in place of the empty-state preview for code_navigate", () => {
    const p = toolResultPresentation("code_navigate", {
      ok: true, kind: "definition", locations: [], notice: "No definition provider for .py files. Is the ms-python.python extension installed?",
    });
    expect(p.state).toBe("fail");
    expect(p.preview).toContain("ms-python.python");
  });

  it("falls back to the bare kind when code_navigate is empty with no notice", () => {
    const p = toolResultPresentation("code_navigate", { ok: true, kind: "references", locations: [] });
    expect(p.preview).toBe("references");
  });

  it("handles code_inlay_hints with hints", () => {
    const p = toolResultPresentation("code_inlay_hints", {
      ok: true, path: "src/foo.ts",
      hints: [{ line: 3, column: 10, label: ": string", kind: "type" }],
    });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("1 hint");
    expect(p.preview).toContain(": string");
  });

  it("handles code_inlay_hints with no hints, surfacing a notice", () => {
    const p = toolResultPresentation("code_inlay_hints", {
      ok: true, path: "src/foo.py", hints: [],
      notice: "No inlay hint provider for .py files. Is the ms-python.python extension installed?",
    });
    expect(p.label).toBe("No hints");
    expect(p.preview).toContain("ms-python.python");
  });

  it("summarizes map_overview without dumping raw architecture JSON", () => {
    const p = toolResultPresentation("map_overview", {
      ok: true,
      coverage: { indexedFiles: 1204, truncated: false },
      projects: [{}, {}],
      areas: [{}, {}, {}],
      serviceFlows: [{}],
    });
    expect(p.label).toBe("1,204 files mapped");
    expect(p.preview).toContain("2 projects");
    expect(p.preview).toContain("3 areas");
    expect(p.preview).toContain("1 service flow");
  });

  it("handles test_run pass result", () => {
    const p = toolResultPresentation("test_run", { ok: true, passed: 10, failed: 0, framework: "vitest", durationMs: 1200 });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("10 passed");
  });

  it("handles test_run failure result", () => {
    const p = toolResultPresentation("test_run", { ok: false, passed: 8, failed: 2, framework: "vitest" });
    expect(p.state).toBe("fail");
    expect(p.label).toContain("2 failed");
  });

  it("handles browser_screenshot with media url", () => {
    const p = toolResultPresentation("browser_screenshot", {
      dataUrl: "data:image/png;base64,xxx",
      url: "https://example.com",
      fullPage: true,
      sizeBytes: 512,
    });
    expect(p.state).toBe("ok");
    expect(p.mediaDataUrl).toBe("data:image/png;base64,xxx");
    expect(p.label).toBe("Screenshot captured");
  });

  it("handles reference_zoom_image with media url", () => {
    const p = toolResultPresentation("reference_zoom_image", {
      name: "photo.png",
      mediaDataUrl: "data:image/png;base64,yyy",
      region: { x: 0, y: 0, width: 20, height: 20 },
      zoomedWidth: 40,
      zoomedHeight: 40,
    });
    expect(p.state).toBe("ok");
    expect(p.mediaDataUrl).toBe("data:image/png;base64,yyy");
    expect(p.label).toBe("Zoomed photo.png");
    expect(p.preview).toBe("20×20 → 40×40");
  });

  it("handles reference_query_spreadsheet result summaries", () => {
    const p = toolResultPresentation("reference_query_spreadsheet", {
      name: "data.csv",
      sheet: null,
      rowCount: 12,
      result: ["Gadget", "Widget"],
    });
    expect(p.state).toBe("ok");
    expect(p.label).toBe("data.csv");
    expect(p.preview).toContain("2 matches");
    expect(p.preview).toContain("12 rows");
  });

  it("handles question_card answered result", () => {
    const p = toolResultPresentation("question_card", { selectedKey: "yes" });
    expect(p.state).toBe("ok");
    expect(p.label).toContain('"yes" selected');
  });

  it("handles subagent_spawn success", () => {
    const p = toolResultPresentation("subagent_spawn", {
      subRequestId: "req-1", answer: "Task done", toolRounds: 5,
    });
    expect(p.state).toBe("ok");
    expect(p.preview).toContain("Task done");
  });

  it("handles subagent_spawn failure (no answer)", () => {
    const p = toolResultPresentation("subagent_spawn", { subRequestId: "req-1", toolRounds: 2 });
    expect(p.state).toBe("fail");
  });

  it("handles github service results - collection", () => {
    const p = toolResultPresentation("github_list_issues", {
      ok: true,
      data: { items: [{ title: "Bug", number: 1 }, { title: "Feature", number: 2 }] },
    });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("2 items");
  });

  it("handles github service results - single entity", () => {
    const p = toolResultPresentation("github_get_issue", {
      ok: true,
      data: { number: 42, title: "Fix the bug", state: "open" },
    });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("Fix the bug");
  });

  it("handles service tool failure", () => {
    const p = toolResultPresentation("jira_get_issue", {
      ok: false, statusCode: 404, data: "Not found",
    });
    expect(p.state).toBe("fail");
    expect(p.label).toBe("Request failed");
    expect(p.preview).toContain("HTTP 404");
  });

  it("handles worktree_op", () => {
    const p = toolResultPresentation("worktree_op", { worktreePath: ".worktrees/feature" });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("feature");
  });

  it("handles mcp_list_tools", () => {
    const p = toolResultPresentation("mcp_list_tools", {
      tools: [{ name: "search" }, { name: "fetch" }],
      server: { url: "https://mcp.example.com" },
    });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("2 tools");
  });

  it("handles tool_output_page success — shows the char range and whether more remains", () => {
    const p = toolResultPresentation("tool_output_page", {
      ok: true, toolCallId: "toolu_1", offset: 20000, totalLength: 87432, hasMore: true, content: "x".repeat(5000),
    });
    expect(p.state).toBe("ok");
    expect(p.label).toContain("20,000");
    expect(p.label).toContain("25,000");
    expect(p.label).toContain("87,432");
    expect(p.preview).toContain("remains");
  });

  it("handles tool_output_page reaching the end", () => {
    const p = toolResultPresentation("tool_output_page", {
      ok: true, toolCallId: "toolu_1", offset: 80000, totalLength: 87432, hasMore: false, content: "x".repeat(7432),
    });
    expect(p.preview).toContain("end");
  });

  it("handles tool_output_page failure via the generic error path", () => {
    const p = toolResultPresentation("tool_output_page", { ok: false, error: "No stored output found for toolCallId \"x\"." });
    expect(p.state).toBe("fail");
    expect(p.label).toBe("Failed");
    expect(p.preview).toContain("No stored output");
  });

  it("handles tool_output_search with matches", () => {
    const p = toolResultPresentation("tool_output_search", {
      ok: true, toolCallId: "toolu_1", pattern: "AssertionError", totalMatches: 3, truncated: false,
      matches: [{ lineNumber: 5, line: "AssertionError: boom", contextBefore: [], contextAfter: [] }],
    });
    expect(p.state).toBe("ok");
    expect(p.label).toBe("3 matches");
    expect(p.preview).toBe("");
  });

  it("handles tool_output_search with no matches", () => {
    const p = toolResultPresentation("tool_output_search", { ok: true, toolCallId: "toolu_1", pattern: "xyz", totalMatches: 0, truncated: false, matches: [] });
    expect(p.label).toBe("No matches");
  });

  it("handles tool_output_search truncated results", () => {
    const p = toolResultPresentation("tool_output_search", {
      ok: true, toolCallId: "toolu_1", pattern: "hit", totalMatches: 30, truncated: true,
      matches: Array.from({ length: 5 }, (_, i) => ({ lineNumber: i, line: "hit", contextBefore: [], contextAfter: [] })),
    });
    expect(p.preview).toContain("narrow the pattern");
  });

  it("handles JSON string result", () => {
    const p = toolResultPresentation("file_read", JSON.stringify({ path: "x.ts", sizeBytes: 100, content: "hi" }));
    expect(p.state).toBe("ok");
    expect(p.label).toContain("x.ts");
  });
});

/* ── toolInputPreview ─────────────────────────────────────────────────────── */

describe("toolInputPreview", () => {
  it("returns empty for null/non-object input", () => {
    expect(toolInputPreview("file_read", null)).toBe("");
    expect(toolInputPreview("file_read", "string")).toBe("");
  });

  it("shell_run shows command and cwd", () => {
    const p = toolInputPreview("shell_run", { command: "npm test", cwd: "/app" });
    expect(p).toContain("npm test");
    expect(p).toContain("/app");
  });

  it("file_read shows path", () => {
    expect(toolInputPreview("file_read", { path: "src/foo.ts" })).toContain("foo.ts");
  });

  it("file_edit shows path and replaceAll flag", () => {
    const p = toolInputPreview("file_edit", { path: "src/foo.ts", replaceAll: true });
    expect(p).toContain("foo.ts");
    expect(p).toContain("all");
  });

  it("file_edit_batch shows edit count", () => {
    const edits = [
      { path: "a.ts", oldString: "x", newString: "y" },
      { path: "b.ts", oldString: "1", newString: "2" },
    ];
    const p = toolInputPreview("file_edit_batch", { edits });
    expect(p).toContain("2 edits");
  });

  it("git_op shows op and branch", () => {
    const p = toolInputPreview("git_op", { op: "commit", branch: "main" });
    expect(p).toContain("commit");
    expect(p).toContain("main");
  });

  it("code_navigate shows kind and symbol", () => {
    const p = toolInputPreview("code_navigate", { kind: "references", target: { symbol: "MyClass" } });
    expect(p).toContain("references");
    expect(p).toContain("MyClass");
  });

  it("code_inlay_hints shows path and line range", () => {
    const p = toolInputPreview("code_inlay_hints", { path: "src/foo.ts", range: { startLine: 10, endLine: 20 } });
    expect(p).toContain("foo.ts");
    expect(p).toContain("10-20");
  });

  it("subagent_spawn shows label and task excerpt", () => {
    const p = toolInputPreview("subagent_spawn", { label: "Research lane", task: "Find all usages of the legacy API" });
    expect(p).toContain("Research lane");
    expect(p).toContain("Find all usages");
  });

  it("browser_navigate shows hostname", () => {
    const p = toolInputPreview("browser_navigate", { url: "https://example.com/page" });
    expect(p).toContain("example.com");
  });

  it("github tools show owner/repo", () => {
    const p = toolInputPreview("github_list_issues", { owner: "acme", repo: "app", number: "" });
    expect(p).toContain("acme");
    expect(p).toContain("app");
  });

  it("mcp_call_tool shows server url and tool name", () => {
    const p = toolInputPreview("mcp_call_tool", {
      server: { url: "https://mcp.example.com" },
      toolName: "search",
    });
    expect(p).toContain("mcp.example.com");
    expect(p).toContain("search");
  });

  it("tool_output_search shows toolCallId and pattern", () => {
    const p = toolInputPreview("tool_output_search", { toolCallId: "toolu_1", pattern: "AssertionError" });
    expect(p).toContain("toolu_1");
    expect(p).toContain("AssertionError");
  });

  it("map_overview describes its ranked architecture scope", () => {
    expect(toolInputPreview("map_overview", { limit: 12 })).toBe("top 12 per section");
  });
});

/* ── toolActivityKind ─────────────────────────────────────────────────────── */

describe("toolActivityKind", () => {
  it("classifies file mutations as 'mutate'", () => {
    for (const name of ["file_write", "file_edit", "file_edit_batch", "code_insert", "file_delete", "code_rename"]) {
      expect(toolActivityKind(name)).toBe("mutate");
    }
  });

  it("classifies execution tools as 'run'", () => {
    for (const name of ["shell_run", "process_start", "test_run", "git_op"]) {
      expect(toolActivityKind(name)).toBe("run");
    }
  });

  it("defaults everything else (reads, searches, nav) to 'read'", () => {
    for (const name of ["file_read", "file_search", "code_navigate", "mcp_call_tool", "unknown_tool"]) {
      expect(toolActivityKind(name)).toBe("read");
    }
  });
});

/* ── toolIntentPhrase ─────────────────────────────────────────────────────── */

describe("toolIntentPhrase", () => {
  it("uses a present-tense verb + file basename for file reads/edits", () => {
    expect(toolIntentPhrase("file_read", { path: "src/deep/auth.ts" })).toEqual({ verb: "Reading", target: "auth.ts" });
    expect(toolIntentPhrase("file_edit", { path: "src/config.ts" })).toEqual({ verb: "Editing", target: "config.ts" });
    expect(toolIntentPhrase("file_write", { path: "a/b/store.ts" })).toEqual({ verb: "Writing", target: "store.ts" });
  });

  it("summarizes a batch edit by file count rather than a path", () => {
    expect(toolIntentPhrase("file_edit_batch", { edits: [{ path: "a" }, { path: "b" }] })).toEqual({ verb: "Editing", target: "2 files" });
  });

  it("surfaces the command for shell runs", () => {
    const p = toolIntentPhrase("shell_run", { command: "npm", args: ["run", "test", "extra"] });
    expect(p.verb).toBe("Running");
    expect(p.target).toBe("npm run test");
  });

  it("shows the git op and the search pattern", () => {
    expect(toolIntentPhrase("git_op", { op: "commit", branch: "main" }).target).toContain("commit");
    expect(toolIntentPhrase("file_search", { pattern: "TODO" })).toEqual({ verb: "Searching", target: "TODO" });
  });

  it("describes map_overview as architectural orientation", () => {
    expect(toolIntentPhrase("map_overview", {})).toEqual({ verb: "Mapping", target: "workspace architecture" });
  });

  it("falls back to a display name + input preview for unknown tools", () => {
    const p = toolIntentPhrase("some_future_tool", { path: "x.ts" });
    expect(p.verb).toBeTruthy();
  });

  it("tolerates missing/non-object input", () => {
    expect(() => toolIntentPhrase("file_read", null)).not.toThrow();
    expect(toolIntentPhrase("file_read", null).verb).toBe("Reading");
  });
});
