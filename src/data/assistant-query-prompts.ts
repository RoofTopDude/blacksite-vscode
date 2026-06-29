// Prompt construction + response parsing for the database assistant.
//
// Pure and `vscode`-free: the planner injects the actual model call, so these
// builders/parsers can be unit-tested in isolation. The assistant is a constrained
// copilot — it inspects the live catalog, proposes ONE SQL statement, and explains
// it; it never decides on its own to execute a write.

import type { DataSurfaceProvider } from "./data-surface-provider.js";

export const ASSISTANT_SYSTEM_PROMPT = [
  "You are a careful SQL assistant for a local SQLite database inside a developer tool.",
  "You are given the live schema. Produce exactly one SQL statement that answers the user's question.",
  "Rules:",
  "- Prefer the stable views (names starting with v_) when they fit the question.",
  "- Use only tables/views/columns that appear in the provided schema.",
  "- Default to read-only SELECT queries. Only propose a write (INSERT/UPDATE/DELETE) when the user explicitly asks to change data, and never DROP/TRUNCATE.",
  "- Always include a LIMIT on broad SELECTs unless the user asks for an aggregate.",
  "Respond ONLY with a JSON object of the form:",
  '{"explanation": "<one or two plain-language sentences>", "sql": "<a single SQL statement>"}',
  "Do not wrap the JSON in markdown fences or add any prose outside the JSON.",
].join("\n");

/** Compact, token-bounded schema description built from the live catalog. */
export function buildSchemaContext(surface: DataSurfaceProvider, maxObjects = 40): string {
  const catalog = surface.getCatalog();
  const lines: string[] = [];
  for (const group of catalog.groups) {
    if (group.type !== "table" && group.type !== "view") continue;
    for (const object of group.objects.slice(0, maxObjects)) {
      try {
        const desc = surface.describeObject(object.name);
        const cols = desc.columns.map((c) => `${c.name} ${c.type || "?"}`).join(", ");
        lines.push(`${desc.type.toUpperCase()} ${object.name}(${cols})`);
      } catch {
        lines.push(`${group.type.toUpperCase()} ${object.name}`);
      }
    }
  }
  return lines.join("\n");
}

export function buildUserPrompt(question: string, schemaContext: string): string {
  return [
    "Schema:",
    schemaContext || "(no tables found)",
    "",
    `Question: ${question.trim()}`,
  ].join("\n");
}

export interface ParsedAssistantResponse {
  explanation: string;
  sql: string | null;
}

/** Extract the assistant's JSON answer, tolerating stray prose or code fences. */
export function parseAssistantResponse(raw: string): ParsedAssistantResponse {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { explanation: trimmed.slice(0, 600), sql: null };
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { explanation?: unknown; sql?: unknown };
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";
    const sqlRaw = typeof parsed.sql === "string" ? parsed.sql.trim() : "";
    const sql = sqlRaw.replace(/;+\s*$/, "") || null;
    return { explanation: explanation || "Proposed query:", sql };
  } catch {
    return { explanation: trimmed.slice(0, 600), sql: null };
  }
}
