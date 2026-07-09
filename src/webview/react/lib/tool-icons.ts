/* Categorizes a tool name into a small icon bucket, purely for visual scanning in the
 * transcript — which kind of thing a tool call is, independent of whether it succeeded
 * (that's the status pill's job, see signal.tsx). Deliberately separate from TOOL_GROUPS
 * in format.ts, which drives the Settings tool-toggle list and groups more coarsely
 * (e.g. all file tools together) than a scannable icon wants (read vs write vs delete
 * should look different at a glance).
 */

export type ToolIconCategory =
  | "file-read" | "file-write" | "file-edit" | "file-delete" | "file-browse" | "file-search"
  | "shell" | "process"
  | "git" | "worktree"
  | "code"
  | "diagnostics"
  | "test"
  | "browser"
  | "memory"
  | "plan" | "todo"
  | "delegate"
  | "page" | "search"
  | "mcp"
  | "data"
  | "integration-issue" | "integration-docs" | "integration-cloud"
  | "question" | "approval"
  | "default";

export function toolIconCategory(toolName: string): ToolIconCategory {
  switch (toolName) {
    case "file_read": return "file-read";
    case "file_write": return "file-write";
    case "file_edit": case "file_edit_batch": case "code_insert": return "file-edit";
    case "file_delete": return "file-delete";
    case "file_list": case "file_mkdir": return "file-browse";
    case "file_glob": case "file_search": return "file-search";
    case "shell_run": return "shell";
    case "process_start": case "process_status": case "process_read_output":
    case "process_send_input": case "process_stop": return "process";
    case "git_op": return "git";
    case "worktree_op": return "worktree";
    case "code_symbols": case "code_navigate": case "code_hierarchy": case "code_hover":
    case "code_rename": case "code_actions": case "code_format": case "code_inlay_hints": return "code";
    case "code_diagnostics": case "report_problems": return "diagnostics";
    case "test_detect": case "test_run": return "test";
    case "memory_append": case "memory_read": case "memory_search": return "memory";
    case "plan_create": case "plan_update": case "plan_list": return "plan";
    case "todo_create": case "todo_update": case "todo_status": case "todo_list": return "todo";
    case "subagent_spawn": return "delegate";
    case "tool_output_page": return "page";
    case "tool_output_search": return "search";
    case "mcp_list_tools": case "mcp_call_tool": return "mcp";
    case "question_card": return "question";
    case "approval": return "approval";
    default:
      if (toolName.startsWith("browser_")) return "browser";
      if (toolName.startsWith("db_")) return "data";
      if (toolName.startsWith("github_") || toolName.startsWith("gitlab_")
        || toolName === "github_op" || toolName === "gitlab_op") return "integration-issue";
      if (toolName.startsWith("jira_") || toolName === "jira_op"
        || toolName.startsWith("confluence_") || toolName === "confluence_op") return "integration-docs";
      if (toolName.startsWith("salesforce_") || toolName === "salesforce_op") return "integration-cloud";
      return "default";
  }
}
