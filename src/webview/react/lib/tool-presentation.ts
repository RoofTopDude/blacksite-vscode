/* Tool result/input presentation. Pure functions ported from the legacy
   webview — given a tool name + raw result/input, produce display strings.
   No DOM access. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  countLabel, diagSuffix, formatBytes, formatDuration, hostLabel, humanizeWord,
  joinParts, readNum, readStr, shortPath, shortText, toolDisplayName, type ToolState,
} from "./format";

export interface ToolPresentation {
  label: string;
  preview: string;
  state: ToolState;
  mediaDataUrl: string;
  mediaLabel: string;
}

export function parseToolResult(raw: any): any {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function shellPreview(result: any): { label: string; preview: string; state: ToolState } {
  const exitCode = readNum(result?.exitCode);
  return {
    label: exitCode == null || exitCode === 0 ? "Command finished" : `Exit ${exitCode}`,
    preview: joinParts([
      shortPath(result?.cwd, 36),
      shortText(result?.stdout || result?.stderr || "", 90),
      result?.timedOut ? "timed out" : "",
    ]),
    state: result?.ok === false || (exitCode != null && exitCode > 0) ? "fail" : "ok",
  };
}

function gitPreview(data: any): { label: string; preview: string; state: ToolState } {
  if (!data || typeof data !== "object") return { label: "Git complete", preview: "", state: "ok" };
  if (Array.isArray(data.commits)) {
    return { label: countLabel(data.commits.length, "commit"), preview: shortText(data.commits[0]?.message || "", 80), state: "ok" };
  }
  if (Array.isArray(data.files)) {
    return { label: countLabel(data.files.length, "file"), preview: joinParts([data.files[0]?.path ? shortPath(data.files[0].path, 40) : "", typeof data.raw === "string" && !data.files.length ? "no changes" : "diff captured"]), state: "ok" };
  }
  if (Array.isArray(data.branches)) {
    return { label: countLabel(data.branches.length, "branch"), preview: data.branches.find((branch: any) => branch.current)?.name || "", state: "ok" };
  }
  if (Array.isArray(data.stashes)) {
    return { label: countLabel(data.stashes.length, "stash"), preview: shortText(data.stashes[0] || "", 80), state: "ok" };
  }
  if (typeof data.branch === "string") {
    const staged = Array.isArray(data.staged) ? data.staged.length : 0;
    const unstaged = Array.isArray(data.unstaged) ? data.unstaged.length : 0;
    const untracked = Array.isArray(data.untracked) ? data.untracked.length : 0;
    return { label: data.branch || "Git status", preview: joinParts([staged ? `${staged} staged` : "", unstaged ? `${unstaged} unstaged` : "", untracked ? `${untracked} untracked` : "clean"]), state: "ok" };
  }
  if (typeof data.hash === "string") {
    return { label: `Commit ${data.hash.slice(0, 8)}`, preview: shortText(data.summary || "", 80), state: "ok" };
  }
  return { label: "Git complete", preview: shortText(JSON.stringify(data), 80), state: "ok" };
}

function isServiceToolName(toolName: string): boolean {
  return /^(github|gitlab|jira|confluence|salesforce)_/.test(toolName)
    || ["github_op", "gitlab_op", "jira_op", "confluence_op", "salesforce_op"].includes(toolName);
}

function serviceCollection(data: any): any[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  const keys = ["items", "issues", "values", "results", "records", "sobjects", "spaces"];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
}

function serviceEntityLabel(entity: any, fallback: string): string {
  if (entity == null) return fallback;
  if (typeof entity === "string") return shortText(entity, 64) || fallback;
  if (typeof entity !== "object") return shortText(String(entity), 64) || fallback;
  const named = [
    entity.title, entity.name, entity.path, entity.filename, entity.summary,
    entity.path_with_namespace, entity.full_name, entity.key, entity.login,
    entity.subject, entity.id, entity.number, entity.iid,
  ].find((value) => value != null && String(value).trim());
  return shortText(String(named || fallback), 64) || fallback;
}

function serviceEntitySummary(entity: any): string {
  if (entity == null) return "";
  if (typeof entity === "string") return shortText(entity, 84);
  if (typeof entity !== "object") return shortText(String(entity), 84);
  const state = entity.status?.name || entity.state || entity.pull_request?.state || "";
  const parts = [
    entity.key,
    entity.title || entity.name || entity.path || entity.filename || entity.summary || entity.path_with_namespace || entity.full_name || entity.login || "",
    state,
  ].filter(Boolean).map((value: any) => shortText(String(value), 48));
  if (parts.length) return joinParts(parts);
  return shortText(JSON.stringify(entity), 84);
}

function serviceResultPresentation(toolName: string, result: any): ToolPresentation {
  const response = result && typeof result === "object" ? result : {};
  const ok = response?.ok !== false;
  const data = response?.data ?? response;
  const state: ToolState = ok ? "ok" : "fail";

  if (!ok) {
    return {
      label: "Request failed",
      preview: joinParts([
        readNum(response?.statusCode) != null ? `HTTP ${response.statusCode}` : "",
        shortText(typeof data === "string" ? data : JSON.stringify(data), 100),
      ]),
      state, mediaDataUrl: "", mediaLabel: "",
    };
  }

  const collection = serviceCollection(data);
  if (collection) {
    return {
      label: countLabel(collection.length, "item"),
      preview: joinParts([
        readNum(response?.statusCode) != null ? `HTTP ${response.statusCode}` : "",
        serviceEntitySummary(collection[0]),
      ]),
      state, mediaDataUrl: "", mediaLabel: "",
    };
  }

  return {
    label: serviceEntityLabel(data, toolDisplayName(toolName)),
    preview: joinParts([
      readNum(response?.statusCode) != null ? `HTTP ${response.statusCode}` : "",
      serviceEntitySummary(data),
    ]),
    state, mediaDataUrl: "", mediaLabel: "",
  };
}

export function toolResultPresentation(toolName: string, rawResult: any): ToolPresentation {
  const result = parseToolResult(rawResult);
  if (result && typeof result === "object" && !Array.isArray(result) && typeof result.error === "string") {
    return { label: "Failed", preview: shortText(result.error, 140), state: "fail", mediaDataUrl: "", mediaLabel: "" };
  }

  if (isServiceToolName(toolName)) {
    return serviceResultPresentation(toolName, result);
  }

  const none = { mediaDataUrl: "", mediaLabel: "" };
  switch (toolName) {
    case "transcript_document":
      return {
        label: readStr(result?.title) || "Transcript document",
        preview: joinParts([
          readStr(result?.docType),
          readNum(result?.wordCount) ? `${readNum(result.wordCount)!.toLocaleString()} words` : "",
          readStr(result?.filename),
        ]),
        state: result?.ok === false ? "fail" : "ok",
        ...none,
      };
    case "browser_screenshot":
      return { label: "Screenshot captured", preview: joinParts([formatBytes(result?.sizeBytes), hostLabel(result?.url), result?.fullPage ? "full page" : "viewport"]), state: "ok", mediaDataUrl: readStr(result?.dataUrl), mediaLabel: hostLabel(result?.url) || "Screenshot preview" };
    case "reference_zoom_image":
      return {
        label: `Zoomed ${readStr(result?.name) || "image"}`,
        preview: result?.region ? `${result.region.width}×${result.region.height} → ${result?.zoomedWidth}×${result?.zoomedHeight}` : "",
        state: "ok",
        mediaDataUrl: readStr(result?.mediaDataUrl),
        mediaLabel: readStr(result?.name) || "Zoomed region",
      };
    case "reference_query_spreadsheet": {
      const rows = Array.isArray(result?.result) ? result.result.length : (result?.result != null ? 1 : 0);
      return {
        label: readStr(result?.name) || "Spreadsheet queried",
        preview: joinParts([result?.sheet ? `sheet: ${result.sheet}` : "", countLabel(rows, "match", "matches"), countLabel(readNum(result?.rowCount) ?? 0, "row")]),
        state: "ok", ...none,
      };
    }
    case "browser_navigate":
      return { label: hostLabel(result?.url) || "Navigation complete", preview: shortText(result?.title || "", 90), state: "ok", ...none };
    case "browser_get_text":
      return { label: "Text captured", preview: joinParts([result?.text ? `${result.text.length} chars` : "", result?.truncated ? "truncated" : "", shortText(result?.text || "", 80)]), state: "ok", ...none };
    case "browser_click":
    case "browser_type":
      return { label: toolName === "browser_click" ? "Element clicked" : "Text entered", preview: joinParts([shortText(result?.selector || "", 60), result?.charsTyped ? `${result.charsTyped} chars` : ""]), state: "ok", ...none };
    case "browser_evaluate":
      return { label: "Evaluation complete", preview: shortText(typeof result?.result === "string" ? result.result : JSON.stringify(result?.result), 90), state: "ok", ...none };
    case "browser_run_script": {
      const steps: Array<Record<string, unknown>> = Array.isArray(result?.steps) ? result.steps : [];
      const lastShot = [...steps].reverse().find((s) => s?.["action"] === "screenshot" && typeof s["dataUrl"] === "string");
      return {
        label: `Script: ${countLabel(steps.length, "step")}${result?.stoppedEarly ? " (stopped early)" : ""}`,
        preview: steps.map((s) => String(s["action"] ?? "")).filter(Boolean).join(" → "),
        state: result?.ok === false ? "fail" : "ok",
        mediaDataUrl: lastShot ? readStr(lastShot["dataUrl"]) : "",
        mediaLabel: lastShot ? "Last screenshot in sequence" : "",
      };
    }
    case "file_list":
      return { label: shortPath(result?.path, 48) || "Directory listed", preview: joinParts([Array.isArray(result?.entries) ? countLabel(result.entries.length, "entry") : "", result?.truncated ? "truncated" : ""]), state: "ok", ...none };
    case "file_read":
      return { label: shortPath(result?.path, 48) || "File read", preview: joinParts([formatBytes(result?.sizeBytes), typeof result?.content === "string" ? `${result.content.length} chars` : ""]), state: "ok", ...none };
    case "file_write":
      return { label: shortPath(result?.path, 48) || "File written", preview: joinParts([formatBytes(result?.bytesWritten), diagSuffix(result)]), state: "ok", ...none };
    case "file_edit":
      return { label: shortPath(result?.path, 48) || "File edited", preview: joinParts([result?.replacements != null ? countLabel(result.replacements, "replacement") : "Applied", diagSuffix(result)]), state: "ok", ...none };
    case "file_edit_batch": {
      const editCount = readNum(result?.edits) ?? (Array.isArray(result?.applied) ? result.applied.length : null);
      const fileCount = readNum(result?.files);
      return {
        label: editCount != null ? countLabel(editCount, "edit") : "Batch edit applied",
        preview: joinParts([fileCount != null ? countLabel(fileCount, "file") : "", diagSuffix(result)]),
        state: "ok", ...none,
      };
    }
    case "json_edit":
      return { label: shortPath(result?.path, 48) || "JSON edited", preview: joinParts([result?.operations != null ? countLabel(result.operations, "operation") : "Applied", diagSuffix(result)]), state: "ok", ...none };
    case "report_problems":
      return { label: result?.count ? countLabel(result.count, "problem") : "Problems cleared", preview: result?.files ? countLabel(result.files, "file") : "", state: "ok", ...none };
    case "code_symbols":
      return { label: result?.scope === "workspace" ? countLabel((result?.symbols || []).length, "symbol") : (shortPath(result?.path, 48) || "Symbols"), preview: result?.scope === "workspace" ? shortText(result?.query || "", 40) : (result?.notice ? shortText(result.notice, 70) : countLabel((result?.symbols || []).length, "top-level symbol")), state: "ok", ...none };
    case "code_navigate": {
      const locs = Array.isArray(result?.locations) ? result.locations : [];
      const first = locs[0];
      return { label: locs.length ? countLabel(locs.length, result?.kind === "references" ? "reference" : "location") : "No results", preview: first ? joinParts([`${shortPath(first.path, 40)}:${first.line}`, result?.truncated ? "truncated" : ""]) : (result?.notice || result?.kind || ""), state: locs.length ? "ok" : "fail", ...none };
    }
    case "code_hierarchy": {
      const rows = Array.isArray(result?.results) ? result.results : [];
      const first = rows[0];
      const unit = result?.kind === "callers" || result?.kind === "callees" ? "call" : "type";
      return { label: rows.length ? countLabel(rows.length, unit) : "No results", preview: first ? joinParts([`${shortText(first.symbol || "", 28)}`, first.path ? `${shortPath(first.path, 32)}:${first.line}` : ""]) : (result?.notice || result?.kind || ""), state: rows.length ? "ok" : "fail", ...none };
    }
    case "code_hover":
      return { label: "Hover", preview: shortText(result?.text || "", 90), state: result?.text ? "ok" : "fail", ...none };
    case "code_diagnostics": {
      const c = result?.counts || {};
      const summary = joinParts([c.error ? countLabel(c.error, "error") : "", c.warning ? countLabel(c.warning, "warning") : ""]);
      return { label: summary || "No problems", preview: joinParts([countLabel((result?.problems || []).length, "shown"), result?.truncated ? "truncated" : ""]), state: c.error ? "fail" : "ok", ...none };
    }
    case "code_rename":
      return { label: result?.newName ? `Renamed → ${shortText(result.newName, 36)}` : "Renamed", preview: joinParts([result?.files != null ? countLabel(result.files, "file") : "", result?.edits != null ? countLabel(result.edits, "edit") : "", diagSuffix(result)]), state: "ok", ...none };
    case "code_replace":
      return { label: result?.symbol ? `Replaced ${shortText(result.symbol, 36)}` : (shortPath(result?.path, 48) || "Replaced"), preview: joinParts([result?.startLine != null && result?.endLine != null ? `lines ${result.startLine}-${result.endLine}` : "", diagSuffix(result)]), state: "ok", ...none };
    case "code_replace_batch": {
      const editCount = readNum(result?.edits);
      const fileCount = readNum(result?.files);
      return {
        label: editCount != null ? countLabel(editCount, "symbol") : "Batch replace applied",
        preview: joinParts([fileCount != null ? countLabel(fileCount, "file") : "", diagSuffix(result)]),
        state: "ok", ...none,
      };
    }
    case "code_actions": {
      if (Array.isArray(result?.actions)) {
        return { label: result.actions.length ? countLabel(result.actions.length, "action") : "No actions", preview: shortText((result.actions[0]?.title) || result?.notice || result?.message || "", 80), state: "ok", ...none };
      }
      return { label: result?.title ? shortText(result.title, 48) : "Code action applied", preview: joinParts([result?.files != null ? countLabel(result.files, "file") : "", result?.ranEditorCommand ? "ran command" : "", diagSuffix(result)]), state: "ok", ...none };
    }
    case "code_format":
      return { label: result?.formatted ? "Formatted" : "Already formatted", preview: result?.edits != null ? countLabel(result.edits, "edit") : (result?.message || result?.notice ? shortText(result.notice || result.message, 70) : ""), state: "ok", ...none };
    case "code_inlay_hints": {
      const hints = Array.isArray(result?.hints) ? result.hints : [];
      return { label: hints.length ? countLabel(hints.length, "hint") : "No hints", preview: hints.length ? joinParts([shortText(hints[0]?.label || "", 40), result?.truncated ? "truncated" : ""]) : (result?.notice || ""), state: "ok", ...none };
    }
    case "file_mkdir":
      return { label: shortPath(result?.path, 48) || "Directory created", preview: "", state: "ok", ...none };
    case "file_delete":
      return { label: shortPath(result?.path, 48) || "Path deleted", preview: "", state: "ok", ...none };
    case "file_glob":
      return { label: shortPath(result?.path, 48) || "Glob complete", preview: joinParts([Array.isArray(result?.results) ? countLabel(result.results.length, "match") : "", shortText(result?.pattern || "", 60), result?.truncated ? "truncated" : ""]), state: "ok", ...none };
    case "file_search":
      return { label: shortPath(result?.path, 48) || "Search complete", preview: joinParts([Array.isArray(result?.results) ? countLabel(result.results.length, "match") : "", shortText(result?.pattern || "", 60), result?.truncated ? "truncated" : ""]), state: "ok", ...none };
    case "question_card":
      return { label: result?.selectedKey ? `"${String(result.selectedKey)}" selected` : "Answered", preview: "", state: "ok", ...none };
    case "shell_run":
      return { ...shellPreview(result), ...none };
    case "process_start":
      return { label: "Process started", preview: joinParts([result?.process?.handleId || "", shortPath(result?.process?.cwd || "", 36)]), state: "ok", ...none };
    case "process_status":
      return { label: result?.process?.status || "Process status", preview: joinParts([result?.process?.handleId || "", shortPath(result?.process?.cwd || "", 36)]), state: result?.process?.status === "failed" ? "fail" : "ok", ...none };
    case "process_read_output":
      return { label: "Output read", preview: joinParts([Array.isArray(result?.output?.entries) ? countLabel(result.output.entries.length, "line") : "", shortText(result?.output?.entries?.[0]?.text || "", 80)]), state: "ok", ...none };
    case "process_stop":
      return { label: result?.stopped ? "Process stopped" : "Stop requested", preview: result?.process?.handleId || "", state: "ok", ...none };
    case "git_op":
      return { ...gitPreview(result?.data || result), ...none };
    case "test_detect":
      return { label: humanizeWord(result?.framework || "unknown"), preview: "test framework", state: result?.framework === "unknown" ? "fail" : "ok", ...none };
    case "test_run":
      return { label: result?.failed ? `${result.failed} failed` : `${result?.passed || 0} passed`, preview: joinParts([result?.framework || "", result?.skipped ? `${result.skipped} skipped` : "", formatDuration(result?.durationMs)]), state: result?.ok === false ? "fail" : "ok", ...none };
    case "worktree_op":
      return { label: shortPath(result?.worktreePath || result?.path || "", 48) || "Worktree updated", preview: shortText(JSON.stringify(result), 80), state: "ok", ...none };
    case "subagent_spawn":
      return { label: result?.subRequestId ? "Delegated lane complete" : "Delegated lane", preview: joinParts([result?.subRequestId || "", result?.toolRounds != null ? countLabel(result.toolRounds, "tool round") : "", shortText(result?.answer || "", 90)]), state: result?.answer ? "ok" : "fail", ...none };
    case "mcp_list_tools":
      return { label: Array.isArray(result?.tools) ? countLabel(result.tools.length, "tool") : "Tools listed", preview: shortText(result?.server?.url || "", 70), state: "ok", ...none };
    case "mcp_call_tool":
      return { label: "MCP tool complete", preview: shortText(typeof result?.content === "string" ? result.content : JSON.stringify(result), 90), state: "ok", ...none };
    case "tool_output_page": {
      // The failure case (unknown/expired toolCallId) is already caught by the generic
      // `result.error` check above this switch — only the success shape reaches here.
      const offset = readNum(result?.offset) ?? 0;
      const total = readNum(result?.totalLength) ?? 0;
      const shown = typeof result?.content === "string" ? result.content.length : 0;
      return {
        label: `Chars ${offset.toLocaleString()}–${(offset + shown).toLocaleString()} of ${total.toLocaleString()}`,
        preview: result?.hasMore ? "More output remains" : "Reached the end of the output",
        state: "ok", ...none,
      };
    }
    case "tool_output_search": {
      const total = readNum(result?.totalMatches) ?? 0;
      const shown = Array.isArray(result?.matches) ? result.matches.length : 0;
      return {
        label: total === 0 ? "No matches" : countLabel(total, "match", "matches"),
        preview: result?.truncated ? `Showing first ${shown} — narrow the pattern for the rest` : "",
        state: "ok", ...none,
      };
    }
    default: {
      if (result && typeof result === "object" && !Array.isArray(result)) {
        if (Array.isArray(result.results)) {
          return { label: countLabel(result.results.length, "result"), preview: shortText(result.results[0] || "", 80), state: "ok", ...none };
        }
        if (typeof result.path === "string") {
          return { label: shortPath(result.path, 48), preview: shortText(JSON.stringify(result), 80), state: "ok", ...none };
        }
      }
      return { label: toolDisplayName(toolName), preview: shortText(typeof result === "string" ? result : JSON.stringify(result), 90), state: "ok", ...none };
    }
  }
}

export function toolInputPreview(toolName: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const data = input;
  if (toolName.startsWith("github_") || toolName === "github_op") {
    return joinParts([joinParts([readStr(data.owner), readStr(data.repo)]), readStr(data.number || data.path || data.ref || ""), shortText(data.query || data.title || data.body || "", 60)]);
  }
  if (toolName.startsWith("gitlab_") || toolName === "gitlab_op") {
    return joinParts([shortText(data.projectId || "", 44), readStr(data.iid || data.sourceBranch || data.targetBranch || ""), shortText(data.title || data.description || "", 60)]);
  }
  if (toolName.startsWith("jira_") || toolName === "jira_op") {
    return joinParts([hostLabel(data.host || ""), readStr(data.key || data.project || ""), shortText(data.jql || data.summary || data.body || "", 60)]);
  }
  if (toolName.startsWith("confluence_") || toolName === "confluence_op") {
    return joinParts([hostLabel(data.host || ""), readStr(data.pageId || data.spaceKey || ""), shortText(data.query || data.title || "", 60)]);
  }
  if (toolName.startsWith("salesforce_") || toolName === "salesforce_op") {
    return joinParts([hostLabel(data.instanceUrl || ""), readStr(data.objectType || data.id || ""), shortText(data.soql || "", 60)]);
  }
  switch (toolName) {
    case "shell_run":
    case "process_start":
      return joinParts([readStr(data.command), Array.isArray(data.args) ? shortText(data.args.slice(0, 3).join(" "), 60) : "", shortPath(data.cwd, 36)]);
    case "process_status":
    case "process_stop":
    case "process_read_output":
      return readStr(data.handleId);
    case "process_send_input":
      return joinParts([readStr(data.handleId), shortText(data.input, 50)]);
    case "file_read":
    case "file_write":
    case "file_delete":
    case "file_mkdir":
    case "file_list":
      return shortPath(data.path, 60);
    case "file_edit":
      return joinParts([shortPath(data.path, 48), data.replaceAll ? "all" : ""]);
    case "file_edit_batch":
      return Array.isArray(data.edits) ? countLabel(data.edits.length, "edit") : "";
    case "json_edit":
      return joinParts([shortPath(data.path, 40), Array.isArray(data.operations) ? countLabel(data.operations.length, "op") : ""]);
    case "file_glob":
      return joinParts([shortPath(data.path, 40), shortText(data.pattern, 60)]);
    case "file_search":
      return joinParts([shortPath(data.path, 40), shortText(data.pattern, 60)]);
    case "git_op":
      return joinParts([readStr(data.op), shortPath(data.path || data.cwd, 40), readStr(data.branch || data.name)]);
    case "memory_append":
      return shortText(data.note, 70);
    case "report_problems":
      return data.clear ? "clear" : (Array.isArray(data.problems) ? countLabel(data.problems.length, "problem") : "");
    case "code_symbols":
      return data.query ? shortText(data.query, 50) : shortPath(data.path, 48);
    case "code_navigate":
    case "code_hierarchy":
      return joinParts([readStr(data.kind), data.target && (data.target.symbol ? shortText(data.target.symbol, 40) : shortPath(data.target.path, 40))]);
    case "code_hover":
      return data.target ? (data.target.symbol ? shortText(data.target.symbol, 40) : shortPath(data.target.path, 48)) : "";
    case "code_diagnostics":
      return joinParts([data.path ? shortPath(data.path, 48) : "workspace", readStr(data.severity)]);
    case "code_rename":
      return joinParts([data.target && (data.target.symbol ? shortText(data.target.symbol, 32) : shortPath(data.target.path, 32)), data.newName ? `→ ${shortText(data.newName, 28)}` : ""]);
    case "code_replace":
      return joinParts([data.target && (data.target.symbol ? shortText(data.target.symbol, 32) : shortPath(data.target.path, 32)), data.endLine != null ? `endLine ${data.endLine}` : ""]);
    case "code_replace_batch":
      return Array.isArray(data.edits) ? countLabel(data.edits.length, "edit") : "";
    case "code_actions":
      return joinParts([shortPath(data.path, 40), data.apply ? `apply: ${shortText(data.apply, 36)}` : `line ${readNum(data.line) ?? "?"}`]);
    case "code_format":
      return shortPath(data.path, 56);
    case "code_inlay_hints":
      return joinParts([shortPath(data.path, 48), data.range ? `lines ${data.range.startLine}-${data.range.endLine}` : ""]);
    case "test_run":
      return joinParts([shortPath(data.cwd || data.root, 36), shortText(data.filter, 60)]);
    case "test_detect":
      return shortPath(data.root, 40);
    case "worktree_op":
      return joinParts([readStr(data.op), readStr(data.taskId), shortPath(data.path, 40)]);
    case "subagent_spawn":
      return joinParts([shortText(data.label, 28), shortText(data.task, 90)]);
    case "browser_navigate":
      return hostLabel(data.url);
    case "browser_click":
    case "browser_type":
    case "browser_get_text":
      return shortText(data.selector, 60);
    case "browser_screenshot":
      return data.fullPage ? "full page" : "viewport";
    case "browser_evaluate":
      return shortText(data.script, 70);
    case "browser_run_script":
      return Array.isArray(data.steps) ? `${countLabel(data.steps.length, "step")}: ${data.steps.map((s: { action?: string }) => s?.action).filter(Boolean).join(" → ")}` : "";
    case "mcp_list_tools":
      return shortText(data.server?.url || "", 70);
    case "mcp_call_tool":
      return joinParts([shortText(data.server?.url || "", 48), readStr(data.toolName)]);
    case "tool_output_page":
      return joinParts([shortText(data.toolCallId, 24), data.offset != null ? `offset ${data.offset}` : ""]);
    case "tool_output_search":
      return joinParts([shortText(data.toolCallId, 24), shortText(data.pattern, 48)]);
    default:
      return joinParts([shortPath(data.path || "", 48), hostLabel(data.url || ""), shortText(data.query || data.jql || data.pattern || data.selector || data.key || data.op || "", 70)]);
  }
}

/** Which "flavor" of work a live tool call is, so the UI can lean warmer/louder
 *  when the agent is *changing* your files versus merely reading them. Mirrors
 *  the icon-category buckets but collapses to the three tones the live surfaces
 *  actually distinguish. */
export type ToolActivityKind = "mutate" | "run" | "read";

export function toolActivityKind(toolName: string): ToolActivityKind {
  switch (toolName) {
    case "file_write": case "file_edit": case "file_edit_batch": case "code_insert": case "code_replace": case "code_replace_batch":
    case "file_delete": case "file_mkdir": case "code_rename": case "code_actions":
    case "code_format": case "json_edit":
      return "mutate";
    case "shell_run": case "process_start": case "process_send_input":
    case "test_run": case "test_detect": case "git_op": case "worktree_op":
      return "run";
    default:
      return "read";
  }
}

/** A short, present-tense "what the agent is doing right now" phrase, split into
 *  a verb and a target so the caller can weight them typographically. Purely for
 *  the live-activity surfaces (chat "now" line, map chip) — distinct from the
 *  past-tense result labels in toolResultPresentation. */
export function toolIntentPhrase(toolName: string, input: any): { verb: string; target: string } {
  const data = input && typeof input === "object" ? input : {};
  const base = (value: unknown): string => {
    const normalized = shortPath(value, 200);
    if (!normalized) return "";
    return normalized.split("/").pop() || normalized;
  };
  const command = (): string => shortText(
    joinParts([readStr(data.command), Array.isArray(data.args) ? data.args.slice(0, 2).join(" ") : ""]).replace(/ · /g, " "),
    40,
  );
  if (toolName.startsWith("browser_")) return { verb: "Browsing", target: hostLabel(data.url) };
  if (isServiceToolName(toolName)) return { verb: humanizeWord(toolName.split("_")[0] ?? "service"), target: shortText(data.query || data.title || data.key || "", 40) };
  switch (toolName) {
    case "file_read": return { verb: "Reading", target: base(data.path) };
    case "file_write": return { verb: "Writing", target: base(data.path) };
    case "file_edit": case "code_insert": case "json_edit": return { verb: "Editing", target: base(data.path) };
    case "file_edit_batch": return { verb: "Editing", target: Array.isArray(data.edits) ? countLabel(data.edits.length, "file") : "files" };
    case "file_delete": return { verb: "Deleting", target: base(data.path) };
    case "file_mkdir": return { verb: "Creating", target: base(data.path) };
    case "file_list": return { verb: "Listing", target: base(data.path) };
    case "file_glob": case "file_search": return { verb: "Searching", target: shortText(data.pattern, 40) };
    case "shell_run": return { verb: "Running", target: command() };
    case "process_start": return { verb: "Starting", target: command() };
    case "process_read_output": case "process_status": case "process_stop": return { verb: "Process", target: readStr(data.handleId) };
    case "git_op": return { verb: "Git", target: joinParts([readStr(data.op), readStr(data.branch || data.name)]) };
    case "worktree_op": return { verb: "Worktree", target: readStr(data.op) };
    case "code_navigate": case "code_hierarchy": return { verb: "Navigating", target: readStr(data.kind) || (data.target?.symbol ? shortText(data.target.symbol, 32) : base(data.target?.path)) };
    case "code_symbols": return { verb: "Scanning", target: data.query ? shortText(data.query, 32) : base(data.path) };
    case "code_hover": return { verb: "Inspecting", target: data.target?.symbol ? shortText(data.target.symbol, 32) : base(data.target?.path) };
    case "code_rename": return { verb: "Renaming", target: data.newName ? `→ ${shortText(data.newName, 28)}` : base(data.target?.path) };
    case "code_replace": return { verb: "Replacing", target: data.target?.symbol ? shortText(data.target.symbol, 32) : base(data.target?.path) };
    case "code_replace_batch": return { verb: "Replacing", target: Array.isArray(data.edits) ? countLabel(data.edits.length, "symbol") : "symbols" };
    case "code_actions": return { verb: "Applying", target: base(data.path) };
    case "code_format": return { verb: "Formatting", target: base(data.path) };
    case "code_inlay_hints": return { verb: "Inspecting", target: base(data.path) };
    case "code_diagnostics": return { verb: "Checking", target: data.path ? base(data.path) : "workspace" };
    case "report_problems": return { verb: "Reporting", target: Array.isArray(data.problems) ? countLabel(data.problems.length, "problem") : "" };
    case "test_run": return { verb: "Testing", target: shortText(data.filter, 32) };
    case "test_detect": return { verb: "Detecting", target: "test framework" };
    case "subagent_spawn": return { verb: "Delegating", target: shortText(data.label || data.task, 40) };
    case "memory_append": return { verb: "Remembering", target: shortText(data.note, 40) };
    case "memory_search": case "memory_read": return { verb: "Recalling", target: shortText(data.query, 40) };
    case "mcp_call_tool": return { verb: "Calling", target: readStr(data.toolName) };
    case "mcp_list_tools": return { verb: "Listing", target: hostLabel(data.server?.url) };
    case "tool_output_page": return { verb: "Continuing", target: "output" };
    case "tool_output_search": return { verb: "Searching", target: shortText(data.pattern, 32) };
    case "question_card": return { verb: "Asking", target: "" };
    default: {
      const preview = toolInputPreview(toolName, data);
      return { verb: toolDisplayName(toolName), target: preview };
    }
  }
}

export function formatDetailValue(value: any, emptyLabel = "No data"): { text: string; empty: boolean } {
  if (value == null || value === "") return { text: emptyLabel, empty: true };
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
  if (text.length > 12000) text = `${text.slice(0, 11980)}\n… [truncated]`;
  return { text, empty: false };
}
