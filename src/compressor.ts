import type { ProviderName } from "./agent-session.js";
import { converseBedrock, mantleMessage } from "./bedrock-client.js";
import type { BedrockThinkingConfig } from "./bedrock-client.js";
import type { BedrockCredentials } from "./bedrock-types.js";
import { HttpError, parseRetryAfter, retryAsync } from "./provider-retry.js";
import { isOpenAIReasoningModel, shallowestReasoningEffort } from "./model-limits.js";
import { canDisableThinking, resolveEffort, resolveThinkingMode } from "./thinking-modes.js";

/**
 * Compaction is a background, best-effort call (a failure degrades to "session continues at
 * full context"), so it retries fewer times and with a tighter ceiling than a foreground
 * model turn — enough to ride out a transient 429/5xx without stalling the turn it blocks.
 */
const COMPRESSION_RETRY_POLICY = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompressorOptions {
  apiKey: string;
  model: string;
  provider: ProviderName;
  baseUrl?: string;
  /** AWS credentials, required when provider === "bedrock". */
  bedrock?: BedrockCredentials;
  /** Selects Bedrock API path: "converse" (default) or "mantle" (Messages API). */
  bedrockApi?: "converse" | "mantle";
}

interface StoredMessage {
  role: "user" | "assistant";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | any[];
}

// ── Compression prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a precision conversation historian. Your job is to compress a conversation transcript into a structured JSON summary that preserves ALL information needed to continue the work without loss.

Analyse every message carefully. The summary MUST be comprehensive enough that an AI resuming the conversation can do so seamlessly, as if it had read the full transcript.

Output ONLY a single valid JSON object — no markdown fences, no prose outside the JSON. Use this exact structure:

{
  "compressionMeta": {
    "messageCount": <integer — how many messages were compressed>,
    "version": 1
  },
  "objective": "<The main goal or task the user and AI are working toward>",
  "status": "<one of: planning | in_progress | awaiting_user | blocked | nearly_complete | complete>",
  "workContext": {
    "files": ["<every file path that was read, written, edited, or referenced>"],
    "technologies": ["<languages, frameworks, libraries, tools, APIs mentioned>"],
    "keySymbols": ["<important variable names, function names, class names, types that were discussed or changed>"],
    "environment": "<OS, runtime, version constraints, or other environment details mentioned>"
  },
  "decisions": [
    {
      "what": "<decision that was made>",
      "why": "<reason or constraint behind it>",
      "impact": "<how this affects future work>"
    }
  ],
  "codeChanges": [
    {
      "file": "<path>",
      "description": "<what was changed and why>",
      "status": "<applied | pending | reverted | discussed-only>"
    }
  ],
  "discoveries": [
    "<important finding, bug, constraint, or architectural insight>"
  ],
  "userRequirements": [
    "<explicit requirement, preference, or constraint the user stated>"
  ],
  "errors": [
    "<errors, failures, or problems that occurred and their resolution status>"
  ],
  "pendingTasks": [
    {
      "task": "<clear description of what needs to be done>",
      "priority": "<high | medium | low>",
      "status": "<pending | in_progress | blocked | done>",
      "blockedBy": "<optional — what is blocking this task>"
    }
  ],
  "conversationNarrative": "<3–6 sentence prose summary of the conversation arc: what was attempted, what worked, what failed, and where things stand now>",
  "criticalContext": "<any other context that MUST be preserved for the conversation to continue correctly — e.g. specific values, agreed-upon constraints, partial work in progress>"
}

Rules:
- Emit the JSON object and nothing else. Do not deliberate, restate the transcript, or explain your choices — no preamble, no commentary, no closing remarks.
- The whole object must fit inside 8,000 output tokens. If the transcript is long, spend that budget on identifiers, decisions, requirements, and pending tasks; tighten the prose in "conversationNarrative" and "criticalContext" first. An object that runs out of budget mid-structure is discarded and the compaction is wasted.
- Be exhaustive. Omitting a decision, file, or requirement causes information loss.
- Use exact file paths, function names, and error messages from the transcript — do not paraphrase identifiers.
- If a field has no relevant content, use an empty array [] or empty string "".
- Do NOT truncate long strings — use the full content for identifiers and key facts.
- A [tool_result] from question_card records an answer the USER gave to a question the assistant asked. These are the only facts in the transcript that cannot be recovered by re-running a tool — recovering one means interrupting the user to ask again. Record every such answer verbatim in "decisions" (the selected label as "what", the question as "why") and repeat it in "userRequirements". Never summarise one away, and never generalise it into a preference the user did not state.`;

// ── Message serialiser ────────────────────────────────────────────────────────

function messagesToText(messages: StoredMessage[]): string {
  // tool_result blocks carry only an id, so the tool that produced them has to be resolved
  // from the assistant tool_use blocks. The summariser needs the name to honour the
  // question_card rule in SYSTEM_PROMPT — an unlabelled result is just anonymous JSON to it.
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (b?.type === "tool_use" && b.id) toolNameById.set(b.id, b.name ?? "unknown");
    }
  }

  return messages.map((m, i) => {
    const role = m.role.toUpperCase();
    let text: string;
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = (m.content as Array<{ type: string; text?: string; thinking?: string; content?: string; name?: string; input?: unknown; tool_use_id?: string }>)
        .filter((b) => b.type === "text" || b.type === "thinking" || b.type === "tool_result" || b.type === "tool_use")
        .map((b) => {
          if (b.type === "thinking") return `[thinking] ${b.thinking ?? ""}`;
          if (b.type === "tool_result") {
            const name = (b.tool_use_id && toolNameById.get(b.tool_use_id)) || "unknown";
            const body = typeof b.content === "string" ? b.content.slice(0, 800) : "";
            return `[tool_result:${name}] ${body}`;
          }
          if (b.type === "tool_use") {
            const args = b.input ? JSON.stringify(b.input).slice(0, 400) : "{}";
            return `[tool_call:${b.name ?? "unknown"}] ${args}`;
          }
          return b.text ?? "";
        })
        .join("\n");
    } else {
      text = "";
    }
    return `[${i}] ${role}: ${text.trim()}`;
  }).join("\n\n");
}

// ── Reasoning: off, on every provider ─────────────────────────────────────────

/**
 * Compaction asks for a transcript to be *transcribed into a schema*, not reasoned about, and
 * it is the one call in the product on a hard deadline with a small output budget. Reasoning
 * defeats both:
 *
 *  - **It eats the answer.** Thinking tokens are billed against the same `max_tokens` as the
 *    output on the Anthropic and OpenAI reasoning paths. A model that thinks for 6k tokens
 *    before writing has ~2k left for a summary the prompt asks to be exhaustive, so the reply
 *    stops mid-JSON with `stop_reason: "max_tokens"` — which {@link validateSummary} rejects,
 *    discarding a summary that was already paid for.
 *  - **It eats the clock.** A non-streaming call returns nothing until the whole answer exists,
 *    and deep reasoning on a long transcript routinely walks past the five-minute budget.
 *
 * Both failures surface the same way: compaction never lands, the session keeps running at full
 * context, and the next turn tries again on an even longer transcript.
 *
 * "Off" therefore has to be *sent*, not left to the default, and every provider spells it
 * differently — which is what the three helpers below are for. The user's own thinking/effort
 * settings are deliberately not consulted: they configure the model doing the work, not the
 * bookkeeping call behind it.
 */
const COMPACTION_EFFORT = "low" as const;

/**
 * The `thinking` object that turns Claude's reasoning off, or undefined when the field must be
 * omitted instead. Mirrors `planThinking`'s off-branch in agent-session, for the same reasons:
 * on Sonnet 5 an absent `thinking` field still runs adaptive, so off has to be stated — while
 * budget-era models (3.7–4.5) are already off when it is absent, and Fable/Mythos think
 * unconditionally and take a 400 on `{type: "disabled"}`.
 */
function claudeThinkingOff(model: string): BedrockThinkingConfig | undefined {
  return resolveThinkingMode(model) === "adaptive" && canDisableThinking(model)
    ? { type: "disabled" }
    : undefined;
}

/**
 * `output_config.effort`, clamped to what the model accepts (undefined when it accepts none).
 *
 * Sent whether or not thinking could be disabled, and it is the only lever that does anything at
 * all on Fable/Mythos. Anthropic documents disabled-thinking plus low effort as the cheap, fast
 * configuration, and the pairing is safe at this rung: Opus 5 rejects disabled thinking only
 * *above* `high`.
 */
function claudeEffortOff(model: string): string | undefined {
  return resolveEffort(model, COMPACTION_EFFORT);
}

/** Anthropic Messages API body fields — the shape Bedrock Mantle speaks too. */
function anthropicReasoningOff(model: string): Record<string, unknown> {
  const thinking = claudeThinkingOff(model);
  const effort = claudeEffortOff(model);
  return {
    ...(thinking ? { thinking } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
}

// ── Provider call helpers ─────────────────────────────────────────────────────

// A non-streaming summary must finish reading the transcript AND generating the entire
// answer before it returns. Sixty seconds routinely expired on long reasoning-model runs.
// Reasoning is now switched off for this call (see above), which removes the largest source
// of that overrun — but a long transcript is still slow to read, so the five-minute budget
// stays. It is shared across retries so overload cannot multiply the total wait.
const COMPRESSION_TIMEOUT_MS = 300_000;

function validateSummary(text: string, stopReason?: string): string {
  if (stopReason === "length" || stopReason === "max_tokens") {
    // Reasoning is off, so the whole 8k budget went to the summary itself: the transcript is
    // genuinely too large for one pass. The actionable levers are the ones that shorten it.
    throw new Error("Summary ran past the output token limit before it finished. Lower Keep Recent or compact at a lower trigger percentage so less transcript reaches the summariser; history was preserved.");
  }
  if (!text.trim()) throw new Error("Provider returned an empty summary; history was preserved.");
  return text;
}

async function callAnthropic(opts: CompressorOptions, transcript: string, signal: AbortSignal): Promise<string> {
  const url: string = opts.baseUrl ?? "https://api.anthropic.com/v1/messages";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": opts.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      ...anthropicReasoningOff(opts.model),
      messages: [{ role: "user", content: `Compress the following conversation transcript:\n\n${transcript}` }],
    }),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(response.status, `Compression API error ${response.status}: ${text.slice(0, 300)}`, parseRetryAfter(response.headers.get("retry-after")));
  }
  const data = await response.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  return validateSummary(data.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? "", data.stop_reason);
}

async function callOpenAI(opts: CompressorOptions, transcript: string, signal: AbortSignal): Promise<string> {
  const pd: Record<string, string> = {
    openai:     "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
  };
  const url: string = opts.baseUrl ?? pd[opts.provider] ?? pd["openai"] ?? "https://api.openai.com/v1/chat/completions";
  // Direct OpenAI's reasoning-tier models (o1/o3/o4, gpt-5+) reject `max_tokens` outright and
  // require `max_completion_tokens` instead — the same quirk the main turn path already handles
  // (see isOpenAIReasoningModel's doc comment). OpenRouter normalizes this for whatever it routes
  // to, so only the direct OpenAI provider needs the substitution.
  const reasoning = opts.provider === "openai" && isOpenAIReasoningModel(opts.model);
  const controlsReasoning = reasoning || opts.provider === "openrouter";
  const send = (reasoningOff: boolean) => fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(opts.provider === "openrouter" ? { "HTTP-Referer": "https://blacksite.dev", "X-Title": "Blacksite" } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      // Reasoning off, in each dialect. Direct OpenAI takes the shallowest rung the model
      // actually has — "none" from gpt-5.1 on, "minimal" on gpt-5.0, "low" for the o-series,
      // which offers nothing shallower. OpenRouter has one unified switch instead, and it
      // applies to whatever it routes to, including models OpenAI never made.
      ...(reasoning
        ? { max_completion_tokens: 8192, ...(reasoningOff ? { reasoning_effort: shallowestReasoningEffort(opts.model) } : {}) }
        : { max_tokens: 8192 }),
      ...(opts.provider === "openrouter" && reasoningOff ? { reasoning: { enabled: false } } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Compress the following conversation transcript:\n\n${transcript}` },
      ],
    }),
    signal,
  });
  let response = await send(controlsReasoning);
  if (!response.ok) {
    let text = await response.text().catch(() => "");
    // Turning reasoning off is an optimisation, not a requirement. OpenRouter answers 400
    // "Reasoning is mandatory for this endpoint and cannot be disabled" for models that always
    // think (Gemini 2.5 Pro, the o-series), and a reasoning model newer than the effort table
    // can reject the rung it was sent. Without this, compaction on those models failed every
    // time and the session never shed context. One retry with the model's own default.
    if (response.status === 400 && controlsReasoning && /reason/i.test(text)) {
      response = await send(false);
      if (!response.ok) text = await response.text().catch(() => "");
    }
    if (!response.ok) {
      throw new HttpError(response.status, `Compression API error ${response.status}: ${text.slice(0, 300)}`, parseRetryAfter(response.headers.get("retry-after")));
    }
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: { message?: string; code?: number } };
  if (data.error) {
    throw new HttpError(data.error.code ?? 500, `Compression API error: ${data.error.message?.slice(0, 300) ?? "Unknown provider error"}`);
  }
  const choice = data.choices?.[0];
  return validateSummary(choice?.message?.content ?? "", choice?.finish_reason);
}

async function callBedrock(opts: CompressorOptions, transcript: string, signal: AbortSignal): Promise<string> {
  if (!opts.bedrock) throw new Error("Bedrock compression requires AWS credentials.");

  if (opts.bedrockApi === "mantle") {
    const response = await mantleMessage({
      credentials: opts.bedrock,
      model: opts.model,
      system: SYSTEM_PROMPT,
      maxTokens: 8192,
      thinking: claudeThinkingOff(opts.model),
      effort: claudeEffortOff(opts.model),
      messages: [{ role: "user", content: `Compress the following conversation transcript:\n\n${transcript}` }],
    }, signal);
    return validateSummary(response.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"), response.stop_reason);
  }

  const response = await converseBedrock({
    credentials: opts.bedrock,
    modelId: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 8192,
    thinking: claudeThinkingOff(opts.model),
    effort: claudeEffortOff(opts.model),
    messages: [{ role: "user", content: [{ text: `Compress the following conversation transcript:\n\n${transcript}` }] }],
  }, signal);
  return validateSummary(response.output.message.content
    .filter((block): block is { text: string } => "text" in block)
    .map((block) => block.text)
    .join("\n\n"), response.stopReason);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function compressHistory(
  opts: CompressorOptions,
  messages: StoredMessage[],
): Promise<string> {
  const transcript = messagesToText(messages);
  const signal = AbortSignal.timeout(COMPRESSION_TIMEOUT_MS);
  let raw: string;
  try {
    raw = await retryAsync(
      () => opts.provider === "anthropic"
        ? callAnthropic(opts, transcript, signal)
        : opts.provider === "bedrock"
        ? callBedrock(opts, transcript, signal)
        : callOpenAI(opts, transcript, signal),
      { policy: COMPRESSION_RETRY_POLICY, signal },
    );
  } catch (err) {
    const detail = signal.aborted
      ? `Timed out after ${COMPRESSION_TIMEOUT_MS / 1000}s while generating the summary. Try a faster compression model or compact earlier.`
      : err instanceof Error ? err.message : String(err);
    const message = `Compression (${opts.provider} / ${opts.model}): ${detail}`;
    // Keep HTTP status and timeout identity so the session can distinguish broken
    // configuration from a transient failure that should recover after a cooldown.
    if (err instanceof HttpError && !signal.aborted) throw new HttpError(err.status, message, err.retryAfterSeconds);
    const error = new Error(message, { cause: err });
    error.name = signal.aborted ? "TimeoutError" : err instanceof Error ? err.name : "Error";
    throw error;
  }

  // Validate the output is JSON — if not, return as-is (graceful degradation)
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) return trimmed;

  const jsonStr = trimmed.slice(start, end + 1);
  try {
    JSON.parse(jsonStr); // validate
    return jsonStr;
  } catch {
    return trimmed;
  }
}
