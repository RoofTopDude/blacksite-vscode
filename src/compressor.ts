import type { ProviderName } from "./agent-session.js";
import { converseBedrock, mantleMessage } from "./bedrock-client.js";
import type { BedrockCredentials } from "./bedrock-types.js";
import { HttpError, parseRetryAfter, retryAsync } from "./provider-retry.js";

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
- Be exhaustive. Omitting a decision, file, or requirement causes information loss.
- Use exact file paths, function names, and error messages from the transcript — do not paraphrase identifiers.
- If a field has no relevant content, use an empty array [] or empty string "".
- Do NOT truncate long strings — use the full content for identifiers and key facts.`;

// ── Message serialiser ────────────────────────────────────────────────────────

function messagesToText(messages: StoredMessage[]): string {
  return messages.map((m, i) => {
    const role = m.role.toUpperCase();
    let text: string;
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = (m.content as Array<{ type: string; text?: string; thinking?: string; content?: string; name?: string; input?: unknown }>)
        .filter((b) => b.type === "text" || b.type === "thinking" || b.type === "tool_result" || b.type === "tool_use")
        .map((b) => {
          if (b.type === "thinking") return `[thinking] ${b.thinking ?? ""}`;
          if (b.type === "tool_result") {
            const body = typeof b.content === "string" ? b.content.slice(0, 800) : "";
            return `[tool_result] ${body}`;
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

// ── Provider call helpers ─────────────────────────────────────────────────────

const COMPRESSION_TIMEOUT_MS = 60_000;

async function callAnthropic(opts: CompressorOptions, transcript: string): Promise<string> {
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
      messages: [{ role: "user", content: `Compress the following conversation transcript:\n\n${transcript}` }],
    }),
    signal: AbortSignal.timeout(COMPRESSION_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(response.status, `Compression API error ${response.status}: ${text.slice(0, 300)}`, parseRetryAfter(response.headers.get("retry-after")));
  }
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}

async function callOpenAI(opts: CompressorOptions, transcript: string): Promise<string> {
  const pd: Record<string, string> = {
    openai:     "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
  };
  const url: string = opts.baseUrl ?? pd[opts.provider] ?? pd["openai"] ?? "https://api.openai.com/v1/chat/completions";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(opts.provider === "openrouter" ? { "HTTP-Referer": "https://blacksite.dev", "X-Title": "Blacksite" } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 8192,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Compress the following conversation transcript:\n\n${transcript}` },
      ],
    }),
    signal: AbortSignal.timeout(COMPRESSION_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(response.status, `Compression API error ${response.status}: ${text.slice(0, 300)}`, parseRetryAfter(response.headers.get("retry-after")));
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callBedrock(opts: CompressorOptions, transcript: string): Promise<string> {
  if (!opts.bedrock) throw new Error("Bedrock compression requires AWS credentials.");

  if (opts.bedrockApi === "mantle") {
    const response = await mantleMessage({
      credentials: opts.bedrock,
      model: opts.model,
      system: SYSTEM_PROMPT,
      maxTokens: 8192,
      messages: [{ role: "user", content: `Compress the following conversation transcript:\n\n${transcript}` }],
    }, AbortSignal.timeout(COMPRESSION_TIMEOUT_MS));
    return response.content.find((b) => b.type === "text")?.text ?? "";
  }

  const response = await converseBedrock({
    credentials: opts.bedrock,
    modelId: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 8192,
    messages: [{ role: "user", content: [{ text: `Compress the following conversation transcript:\n\n${transcript}` }] }],
  }, AbortSignal.timeout(COMPRESSION_TIMEOUT_MS));
  return response.output.message.content
    .filter((block): block is { text: string } => "text" in block)
    .map((block) => block.text)
    .join("\n\n");
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function compressHistory(
  opts: CompressorOptions,
  messages: StoredMessage[],
): Promise<string> {
  const transcript = messagesToText(messages);
  const raw = await retryAsync(
    () => opts.provider === "anthropic"
      ? callAnthropic(opts, transcript)
      : opts.provider === "bedrock"
      ? callBedrock(opts, transcript)
      : callOpenAI(opts, transcript),
    { policy: COMPRESSION_RETRY_POLICY },
  );

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
