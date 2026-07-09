import { describe, expect, it } from "vitest";
import { toolIconCategory } from "../../src/webview/react/lib/tool-icons.js";

describe("toolIconCategory", () => {
  it("distinguishes file operations by intent, not just 'file'", () => {
    expect(toolIconCategory("file_read")).toBe("file-read");
    expect(toolIconCategory("file_write")).toBe("file-write");
    expect(toolIconCategory("file_edit")).toBe("file-edit");
    expect(toolIconCategory("file_edit_batch")).toBe("file-edit");
    expect(toolIconCategory("code_insert")).toBe("file-edit");
    expect(toolIconCategory("file_delete")).toBe("file-delete");
    expect(toolIconCategory("file_list")).toBe("file-browse");
    expect(toolIconCategory("file_mkdir")).toBe("file-browse");
    expect(toolIconCategory("file_glob")).toBe("file-search");
    expect(toolIconCategory("file_search")).toBe("file-search");
  });

  it("categorizes shell and process tools", () => {
    expect(toolIconCategory("shell_run")).toBe("shell");
    for (const name of ["process_start", "process_status", "process_read_output", "process_send_input", "process_stop"]) {
      expect(toolIconCategory(name)).toBe("process");
    }
  });

  it("categorizes git vs worktree distinctly", () => {
    expect(toolIconCategory("git_op")).toBe("git");
    expect(toolIconCategory("worktree_op")).toBe("worktree");
  });

  it("categorizes code intelligence tools together, diagnostics separately", () => {
    for (const name of ["code_symbols", "code_navigate", "code_hover", "code_rename", "code_actions", "code_format", "code_inlay_hints"]) {
      expect(toolIconCategory(name)).toBe("code");
    }
    expect(toolIconCategory("code_diagnostics")).toBe("diagnostics");
    expect(toolIconCategory("report_problems")).toBe("diagnostics");
  });

  it("categorizes tests, memory, planning, delegation, and mcp", () => {
    expect(toolIconCategory("test_detect")).toBe("test");
    expect(toolIconCategory("test_run")).toBe("test");
    expect(toolIconCategory("memory_append")).toBe("memory");
    expect(toolIconCategory("memory_read")).toBe("memory");
    expect(toolIconCategory("memory_search")).toBe("memory");
    expect(toolIconCategory("plan_create")).toBe("plan");
    expect(toolIconCategory("plan_update")).toBe("plan");
    expect(toolIconCategory("plan_list")).toBe("plan");
    expect(toolIconCategory("todo_create")).toBe("todo");
    expect(toolIconCategory("todo_list")).toBe("todo");
    expect(toolIconCategory("subagent_spawn")).toBe("delegate");
    expect(toolIconCategory("tool_output_page")).toBe("page");
    expect(toolIconCategory("tool_output_search")).toBe("search");
    expect(toolIconCategory("mcp_list_tools")).toBe("mcp");
    expect(toolIconCategory("mcp_call_tool")).toBe("mcp");
  });

  it("categorizes question cards and generic approvals distinctly", () => {
    expect(toolIconCategory("question_card")).toBe("question");
    expect(toolIconCategory("approval")).toBe("approval");
  });

  it("categorizes prefixed families by prefix", () => {
    expect(toolIconCategory("browser_navigate")).toBe("browser");
    expect(toolIconCategory("browser_screenshot")).toBe("browser");
    expect(toolIconCategory("db_run_read_query")).toBe("data");
    expect(toolIconCategory("db_list_objects")).toBe("data");
  });

  it("groups issue-tracker integrations (github/gitlab) together", () => {
    expect(toolIconCategory("github_list_issues")).toBe("integration-issue");
    expect(toolIconCategory("github_op")).toBe("integration-issue");
    expect(toolIconCategory("gitlab_create_mr")).toBe("integration-issue");
    expect(toolIconCategory("gitlab_op")).toBe("integration-issue");
  });

  it("groups docs integrations (jira/confluence) together", () => {
    expect(toolIconCategory("jira_get_issue")).toBe("integration-docs");
    expect(toolIconCategory("jira_op")).toBe("integration-docs");
    expect(toolIconCategory("confluence_search")).toBe("integration-docs");
    expect(toolIconCategory("confluence_op")).toBe("integration-docs");
  });

  it("categorizes salesforce as a cloud integration", () => {
    expect(toolIconCategory("salesforce_query")).toBe("integration-cloud");
    expect(toolIconCategory("salesforce_op")).toBe("integration-cloud");
  });

  it("falls back to default for unknown tool names", () => {
    expect(toolIconCategory("totally_unknown_tool")).toBe("default");
    expect(toolIconCategory("")).toBe("default");
  });
});
