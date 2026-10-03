/**
 * On-demand tool loading.
 *
 * The whole catalog — roughly 45k tokens of definitions for 119 tools before integrations — used
 * to ride on every request, on every route, and in every delegated lane. Most turns touch a
 * handful of tools, and selection accuracy drops as the list grows. Only a small core now loads up
 * front; everything else is named in a roster inside `tool_search`'s description and loaded when
 * the model asks for it.
 *
 * Two mechanisms, chosen per request:
 *
 *  - **Native (Anthropic API).** Every available tool is sent, the non-core ones marked
 *    `defer_loading: true`. The API keeps deferred definitions out of the cached prefix and expands
 *    the `tool_reference` blocks that tool_search returns, so loading a tool never invalidates the
 *    prompt cache.
 *  - **Client-side (every other route).** Only core and already-loaded tools are sent. A load adds
 *    tools to the list from the next request on, which costs one cache miss per load; loads are
 *    sticky for the session, so that happens a few times per conversation at most.
 */

import type { ToolDefinition } from "../tools/definitions.js";
import {
  CODE_INTEL_TOOLS, DATA_TOOLS, DIAGNOSTICS_TOOLS, DIAGRAM_TOOLS, GIT_TOOLS, GRAPH_TOOLS, LOOP_TOOLS, MEMORY_TOOLS,
  AGENT_MEMORY_TOOLS, PLANNING_TOOLS, REFERENCE_TOOLS, RESEARCH_TOOLS, RESULT_PAGING_TOOLS, SEQUENCE_TOOLS,
  SERVICE_TOOLS, SKILL_TOOLS, SUBAGENT_TOOLS, TEST_TOOLS, TICKET_TOOLS, TRANSCRIPT_DOCUMENT_TOOLS,
  TRANSCRIPT_TOOLS, UI_TOOLS, WORKSPACE_TOOLS, WORKTREE_TOOLS, BROWSER_TOOLS,
} from "../tools/definitions.js";

export const TOOL_SEARCH_NAME = "tool_search";

/**
 * Loaded on every request. Chosen by how often a turn needs them *without warning*: reading,
 * searching and editing files, running commands and tests, and the tools the harness itself
 * demands — verification (code_diagnostics, test_run), the Codebase Map note the completion
 * checklist asks for, the workspace_refresh its reminders point to, paging a truncated result, loading a skill the roster points at, delegating,
 * and asking the user. Anything else costs one tool_search round the first time it is used.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "file_read", "file_search", "file_list", "file_glob", "file_edit", "file_edit_batch", "file_write",
  "shell_run", "git_op", "test_run", "code_diagnostics", "workspace_refresh",
  "tool_output_page", "tool_output_search", "skill_read", "map_note_add", "subagent_spawn",
  "question_card", TOOL_SEARCH_NAME,
]);

/** Roster headings, in the order families are listed. A tool not covered here is listed under
 *  "Other" rather than dropped — the roster must name everything that can be loaded. */
const TOOL_FAMILIES: ReadonlyArray<{ label: string; tools: readonly ToolDefinition[] }> = [
  { label: "Workspace files and background processes", tools: WORKSPACE_TOOLS },
  { label: "Code intelligence (language server: symbols, navigation, hierarchy, hover, rename, code actions, formatting)", tools: CODE_INTEL_TOOLS },
  { label: "Problems panel", tools: DIAGNOSTICS_TOOLS },
  { label: "Git, tests and worktrees", tools: [...GIT_TOOLS, ...TEST_TOOLS, ...WORKTREE_TOOLS] },
  { label: "Plans, todo runs and plan documents", tools: PLANNING_TOOLS },
  { label: "Tickets (the follow-up work queue)", tools: TICKET_TOOLS },
  { label: "Codebase Map (overview, find, impact, paths, relationships, notes)", tools: GRAPH_TOOLS },
  { label: "Memory and past context", tools: [...MEMORY_TOOLS, ...AGENT_MEMORY_TOOLS, ...TRANSCRIPT_TOOLS, ...TRANSCRIPT_DOCUMENT_TOOLS] },
  { label: "Diagrams saved with the project (check, read, save, edit Mermaid and chart source)", tools: DIAGRAM_TOOLS },
  { label: "Skills", tools: SKILL_TOOLS },
  { label: "Subagents", tools: SUBAGENT_TOOLS },
  { label: "Large-result paging", tools: RESULT_PAGING_TOOLS },
  { label: "Attached references and documents", tools: REFERENCE_TOOLS },
  { label: "Data workbench (SQLite and vector search)", tools: DATA_TOOLS },
  { label: "Execution Runs (recorded browser and local tool sequences)", tools: SEQUENCE_TOOLS },
  { label: "Ticket Loops", tools: LOOP_TOOLS },
  { label: "Browser automation", tools: BROWSER_TOOLS },
  { label: "Web research (domain-approved reads and search)", tools: RESEARCH_TOOLS },
  { label: "External services (configured integrations)", tools: SERVICE_TOOLS },
  { label: "User interface (questions, design tokens, preview rendering)", tools: UI_TOOLS },
];

export function isCoreTool(name: string): boolean {
  return CORE_TOOL_NAMES.has(name);
}

/**
 * The deferred tools, named by family. Names only: the definitions arrive when a tool is loaded,
 * and a family heading carries most of what a name alone does not.
 */
export function buildToolRoster(deferred: readonly ToolDefinition[]): string {
  const remaining = new Map(deferred.map((tool) => [tool.name, tool]));
  const lines: string[] = [];
  for (const family of TOOL_FAMILIES) {
    const names = family.tools.map((tool) => tool.name).filter((name) => remaining.delete(name));
    if (names.length) lines.push(`- ${family.label}: ${names.join(", ")}`);
  }
  if (remaining.size) lines.push(`- Other: ${[...remaining.keys()].join(", ")}`);
  return lines.join("\n");
}

/** A tool description's opening sentence, for the one-line summary tool_search returns. */
export function firstSentence(description: string, max = 160): string {
  const match = /^.*?[.!?](?=\s|$)/s.exec(description.trim());
  const sentence = (match ? match[0] : description.trim()).replace(/\s+/g, " ");
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

export function toolSearchDescription(roster: string): string {
  return [
    "Load tools that are not loaded yet. To keep context small only core tools load up front; the tools below exist and are ready to use, but each must be loaded once before its first call.",
    "Pass `names` with the exact tools you need — load several at once when you can see you will need them — or `query` to find tools by what they do. A loaded tool stays available for the rest of the conversation, so never load the same tool twice.",
    roster ? `Available to load:\n${roster}` : "Every available tool is already loaded.",
  ].join("\n\n");
}

const WORD = /[a-z0-9]+/g;

function tokens(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((word) => word.length >= 2);
}

function schemaPropertyNames(tool: ToolDefinition): string[] {
  return Object.keys(tool.input_schema.properties ?? {});
}

/**
 * Keyword search over deferred tools. A name hit outweighs a description hit, so "rename" finds
 * code_rename before the tools that merely mention renaming. Ties keep catalog order, which puts
 * the more commonly used member of a family first.
 */
export function searchTools(query: string, candidates: readonly ToolDefinition[], limit = 5): ToolDefinition[] {
  const words = [...new Set(tokens(query))];
  if (!words.length) return [];
  const scored = candidates.map((tool, index) => {
    const nameWords = tokens(tool.name.replace(/_/g, " "));
    const description = tool.description.toLowerCase();
    const params = schemaPropertyNames(tool).join(" ").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (nameWords.includes(word)) score += 4;
      else if (tool.name.toLowerCase().includes(word)) score += 2;
      if (description.includes(word)) score += 1;
      if (params.includes(word)) score += 0.5;
    }
    return { tool, index, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.tool);
}

/**
 * Models the Anthropic tool search tool (and so `defer_loading` and `tool_reference`) supports:
 * Claude 4.5 and later, plus every Fable and Mythos model. Anything unrecognized uses the
 * client-side mechanism, which works everywhere.
 */
export function supportsNativeToolSearch(model: string): boolean {
  const id = model.toLowerCase();
  if (/claude-(fable|mythos)/.test(id)) return true;
  const match = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(id);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return major > 4 || (major === 4 && minor >= 5);
}

type WireBlock = Record<string, unknown>;
type WireMessage = { role: string; content: unknown };

/**
 * Replace the content of tool_search results with `tool_reference` blocks, for a native request.
 *
 * Stored history keeps the plain JSON result (every other route reads that), and the references
 * are applied only at serialization. A reference to a tool this request does not send would be a
 * 400, so those are dropped; a result left with no loadable reference keeps its text.
 */
export function expandToolReferences<T extends WireMessage>(
  messages: readonly T[],
  references: ReadonlyMap<string, readonly string[]>,
  sentToolNames: ReadonlySet<string>,
): T[] {
  if (references.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = (message.content as WireBlock[]).map((block) => {
      if (block?.["type"] !== "tool_result") return block;
      const names = references.get(String(block["tool_use_id"] ?? ""));
      const loadable = names?.filter((name) => sentToolNames.has(name)) ?? [];
      if (!loadable.length) return block;
      changed = true;
      return { ...block, content: loadable.map((name) => ({ type: "tool_reference", tool_name: name })) };
    });
    return changed ? { ...message, content } : message;
  });
}
