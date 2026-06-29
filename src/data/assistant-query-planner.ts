// The agentic query assistant.
//
// Flow (BLA-81 "Assistant interaction model"): inspect the live catalog → ask the
// model for one statement → classify its safety → for read-only proposals, run it
// and summarise the result; for writes, return the proposal unexecuted with a
// "needs confirmation" flag so nothing destructive happens silently. The model call
// itself is injected (`generate`) so this stays provider-agnostic and testable.

import type { DataSurfaceProvider } from "./data-surface-provider.js";
import type { DataAssistant, DataAssistantReply } from "../data-provider.js";
import { classifyQuery } from "./query-guard.js";
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildSchemaContext,
  buildUserPrompt,
  parseAssistantResponse,
} from "./assistant-query-prompts.js";

export type AssistantGenerate = (system: string, user: string) => Promise<string>;

export class AssistantQueryPlanner implements DataAssistant {
  constructor(
    private readonly surface: DataSurfaceProvider,
    private readonly generate: AssistantGenerate,
  ) {}

  async ask(question: string): Promise<DataAssistantReply> {
    const trimmed = question.trim();
    if (!trimmed) return { ok: false, explanation: "", error: "Ask a question first." };

    let raw: string;
    try {
      const schema = buildSchemaContext(this.surface);
      raw = await this.generate(ASSISTANT_SYSTEM_PROMPT, buildUserPrompt(trimmed, schema));
    } catch (err) {
      return { ok: false, explanation: "", error: err instanceof Error ? err.message : String(err) };
    }

    const parsed = parseAssistantResponse(raw);
    if (!parsed.sql) {
      return { ok: true, explanation: parsed.explanation };
    }

    const classification = classifyQuery(parsed.sql);
    const safety = classification.overall;

    // Read-only proposals are safe to run immediately — enrich the answer with a
    // result summary. Anything else is returned unexecuted, flagged for confirmation.
    if (classification.readOnly && !classification.multiple) {
      try {
        const result = await this.surface.runQuery(parsed.sql, { maxRows: 50 });
        if (result.ok && result.kind === "read") {
          const summary = `${parsed.explanation} (returned ${result.rowCount} row${result.rowCount === 1 ? "" : "s"})`;
          return { ok: true, explanation: summary, sql: parsed.sql, safety, needsConfirmation: false };
        }
      } catch {
        // Fall through and still return the proposed SQL even if the probe run failed.
      }
      return { ok: true, explanation: parsed.explanation, sql: parsed.sql, safety, needsConfirmation: false };
    }

    return {
      ok: true,
      explanation: `${parsed.explanation} This statement modifies data — review it and run it from the Query tab to confirm.`,
      sql: parsed.sql,
      safety,
      needsConfirmation: true,
    };
  }
}
