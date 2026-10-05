/*
  Hosted web search: the model provider's own search tool, run on its servers inside the model's
  turn. Blacksite declares the tool, shows each search as a finished web_search row, and keeps
  whatever the provider needs replayed — it never executes or answers the search itself.

  Pure helpers only (tool declarations and result parsing), so each provider's wire shape is
  testable without a session. The policy that decides whether a search is on lives in
  ResearchHost; the session decides which route it is on.
*/
import type { HostedSearchPolicy } from "../browser/approval-types.js";
import type { HostedSearchResult } from "../agent-loop-contract.js";

/** Searches the provider may run inside one request. Keeps one runaway reply from spending a
 *  dollar on search before the user sees anything. */
export const HOSTED_SEARCH_MAX_USES = 5;
/** Results per search shown and requested where the provider takes a count. */
const RESULTS_PER_SEARCH = 8;
/** Both Anthropic and OpenRouter cap domain filters; a long list is a request_too_large. */
const MAX_FILTER_DOMAINS = 100;

/**
 * Anthropic's server-side web search tool. The basic version on purpose: from 20260209 on, the
 * tool runs through code execution by default (dynamic filtering), which brings its own result
 * blocks and a container this harness does not manage. Allowed and blocked lists cannot be sent
 * together, so the scope picks one.
 */
export function anthropicWebSearchTool(policy: HostedSearchPolicy): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: HOSTED_SEARCH_MAX_USES };
  if (policy.scope === "approved") tool["allowed_domains"] = policy.allowedDomains.slice(0, MAX_FILTER_DOMAINS);
  else if (policy.deniedDomains.length) tool["blocked_domains"] = policy.deniedDomains.slice(0, MAX_FILTER_DOMAINS);
  return tool;
}

/** OpenRouter's server tool. `engine: auto` uses the routed model's own search where it has one
 *  and Exa otherwise, so it works whichever model is selected. */
export function openRouterWebSearchTool(policy: HostedSearchPolicy): Record<string, unknown> {
  const parameters: Record<string, unknown> = { max_uses: HOSTED_SEARCH_MAX_USES, max_results: RESULTS_PER_SEARCH };
  if (policy.scope === "approved") parameters["allowed_domains"] = policy.allowedDomains.slice(0, MAX_FILTER_DOMAINS);
  else if (policy.deniedDomains.length) parameters["excluded_domains"] = policy.deniedDomains.slice(0, MAX_FILTER_DOMAINS);
  return { type: "openrouter:web_search", parameters };
}

/** Codex thread config for ChatGPT sign-in. "cached" reads OpenAI's index without fetching
 *  live pages; Codex can only allow-list, so "any" scope sends no filter. */
export function codexWebSearchConfig(policy: HostedSearchPolicy | undefined): Record<string, unknown> {
  if (!policy) return { web_search: "disabled" };
  // Codex rejects explicit nulls in this table ("did not match any variant of untagged enum
  // WebSearchToolConfigInput"), so only the key that is actually set is sent.
  return policy.scope === "approved"
    ? { web_search: "cached", "tools.web_search": { allowed_domains: policy.allowedDomains.slice(0, MAX_FILTER_DOMAINS) } }
    : { web_search: "cached" };
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function result(title: unknown, url: unknown, snippet?: unknown, age?: unknown): HostedSearchResult {
  const out: HostedSearchResult = {};
  const t = text(title, 300); if (t) out.title = t;
  const u = text(url, 2000); if (u) out.url = u;
  const s = text(snippet, 600); if (s) out.snippet = s;
  const a = text(age, 80); if (a) out.age = a;
  return out;
}

/**
 * An Anthropic `web_search_tool_result` block's content: a result list, or one error object.
 * Only the visible fields are read; `encrypted_content` stays in the block for replay.
 */
export function anthropicSearchResults(content: unknown): { results: HostedSearchResult[]; error?: string } {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const code = (content as Record<string, unknown>)["error_code"];
    return { results: [], error: typeof code === "string" ? code : "unavailable" };
  }
  const list = Array.isArray(content) ? content : [];
  return {
    results: list
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => result(item["title"], item["url"], undefined, item["page_age"])),
  };
}

/** Results of a Codex `webSearch` thread item: `{ type: "text_result", title, url, domain, snippet }`. */
export function codexSearchResults(results: unknown): HostedSearchResult[] {
  return (Array.isArray(results) ? results : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => result(item["title"], item["url"] ?? item["domain"], item["snippet"]))
    .filter((item) => item.url || item.title);
}

/**
 * Sources from OpenRouter `url_citation` annotations, deduplicated by URL. Accepts both the
 * nested form (`{ type: "url_citation", url_citation: { url, title, content } }`) and the flat one.
 */
export function openRouterCitations(annotations: unknown): HostedSearchResult[] {
  const seen = new Set<string>();
  const out: HostedSearchResult[] = [];
  for (const raw of Array.isArray(annotations) ? annotations : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const inner = (entry["url_citation"] && typeof entry["url_citation"] === "object" ? entry["url_citation"] : entry) as Record<string, unknown>;
    if (entry["type"] !== undefined && entry["type"] !== "url_citation") continue;
    const url = text(inner["url"], 2000);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(result(inner["title"], url, inner["content"]));
  }
  return out;
}

/**
 * A `reasoning.server_tool_call` record from OpenRouter's `reasoning_details`, when the provider
 * reports the search call itself. Returns the query and any results it carries, or undefined for
 * any other reasoning detail.
 */
export function openRouterServerToolCall(detail: unknown): { id: string; query: string; results: HostedSearchResult[] } | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const d = detail as Record<string, unknown>;
  if (d["type"] !== "reasoning.server_tool_call") return undefined;
  const name = String(d["tool_name"] ?? d["name"] ?? "");
  if (name && !/web_search/i.test(name)) return undefined;
  let args: unknown = d["arguments"];
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { query: args }; } }
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const query = text(a["query"] ?? a["q"], 500) ?? "";
  let raw: unknown = d["result"];
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = undefined; } }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as Record<string, unknown>)["results"] : undefined;
  const results = (Array.isArray(list) ? list : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => result(item["title"], item["url"], item["content"] ?? item["snippet"] ?? item["text"]))
    .filter((item) => item.url || item.title);
  const id = text(d["tool_call_id"] ?? d["id"], 200) ?? `openrouter-search-${query}`;
  return { id, query, results };
}

/** A Codex code-mode `exec` cell that only ran the built-in web tool — safe to replay as is,
 *  because it calls nothing of Blacksite's that would then need an answer. */
export function isCodexSearchCell(input: unknown): boolean {
  return typeof input === "string" && /\btools\s*\.\s*web__run\b|\btools\s*\[\s*["']web__run["']\s*\]/.test(input)
    && !/blacksite_/.test(input);
}

/** One line for the transcript row of a finished hosted search. */
export function hostedSearchSummary(provider: string, count: number, error?: string): string {
  if (error) return `${provider} search failed: ${error.replace(/_/g, " ")}`;
  return `${count} result${count === 1 ? "" : "s"} from ${provider}'s search`;
}
