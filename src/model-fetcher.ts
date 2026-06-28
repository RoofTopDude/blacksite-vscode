import https from "https";
import http from "http";
import type { ProviderName } from "./agent-session.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  inputPricePerM?: number;   // USD per 1M input tokens
  outputPricePerM?: number;  // USD per 1M output tokens
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  source: "api" | "fallback";
}

// ── Hardcoded fallbacks ────────────────────────────────────────────────────────

const FALLBACK_MODELS: Record<ProviderName, ModelInfo[]> = {
  anthropic: [
    { id: "claude-opus-4-8",              name: "Claude Opus 4.8",       contextLength: 200000, inputPricePerM: 15,   outputPricePerM: 75,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-4-6",            name: "Claude Sonnet 4.6",     contextLength: 200000, inputPricePerM: 3,    outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-haiku-4-5-20251001",    name: "Claude Haiku 4.5",      contextLength: 200000, inputPricePerM: 0.80, outputPricePerM: 4,    supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-3-7-sonnet-20250219",   name: "Claude 3.7 Sonnet",     contextLength: 200000, inputPricePerM: 3,    outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-3-5-sonnet-20241022",   name: "Claude 3.5 Sonnet",     contextLength: 200000, inputPricePerM: 3,    outputPricePerM: 15,   supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4-8",    name: "Claude Opus 4.8 (OR)",  contextLength: 200000, inputPricePerM: 15,   outputPricePerM: 75,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-sonnet-4-6",  name: "Claude Sonnet 4.6 (OR)", contextLength: 200000, inputPricePerM: 3,   outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-4o",               name: "GPT-4o (OR)",            contextLength: 128000, inputPricePerM: 2.5,  outputPricePerM: 10,   supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "google/gemini-2.5-pro",        name: "Gemini 2.5 Pro (OR)",   contextLength: 1048576,inputPricePerM: 1.25, outputPricePerM: 10,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/o3-mini",              name: "o3-mini (OR)",           contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4,  supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
  ],
  openai: [
    { id: "gpt-4o",        name: "GPT-4o",        contextLength: 128000, inputPricePerM: 2.5,  outputPricePerM: 10,  supportsThinking: false, supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-4o-mini",   name: "GPT-4o mini",   contextLength: 128000, inputPricePerM: 0.15, outputPricePerM: 0.60,supportsThinking: false, supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o3",            name: "o3",             contextLength: 200000, inputPricePerM: 10,   outputPricePerM: 40,  supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o3-mini",       name: "o3-mini",        contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4, supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
    { id: "o1",            name: "o1",             contextLength: 200000, inputPricePerM: 15,   outputPricePerM: 60,  supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o1-mini",       name: "o1-mini",        contextLength: 128000, inputPricePerM: 1.1,  outputPricePerM: 4.4, supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
  ],
};

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error(`Bad URL: ${url}`)); return; }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── Thinking detection ─────────────────────────────────────────────────────────

function detectsThinking(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Anthropic thinking models
  if (id.includes("claude-4") || id.includes("claude-sonnet-4") || id.includes("claude-opus-4")
      || id.includes("3-7") || id.includes("claude-3-7")) return true;
  // OpenAI reasoning models
  if (/^(anthropic\/)?o[13]/.test(id) || id.startsWith("o1") || id.startsWith("o3")) return true;
  // OpenRouter-prefixed
  if (id.startsWith("openai/o")) return true;
  return false;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function fetchAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://api.anthropic.com/v1/models", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`Anthropic /v1/models returned ${status}`);
  const data = (JSON.parse(body) as { data?: Array<{ id: string; display_name?: string }> }).data ?? [];
  return data.map((m) => ({
    id: m.id,
    name: m.display_name ?? m.id,
    supportsThinking: detectsThinking(m.id),
    supportsVision: true,
    supportsTools: true,
    source: "api" as const,
  }));
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

async function fetchOpenRouter(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://openrouter.ai/api/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`OpenRouter /api/v1/models returned ${status}`);
  const data = (JSON.parse(body) as {
    data?: Array<{
      id: string; name?: string; context_length?: number;
      pricing?: { prompt?: string; completion?: string };
    }>
  }).data ?? [];

  return data
    .filter((m) => m.id && !m.id.endsWith(":free") || true) // include free tier models too
    .map((m) => {
      const inp  = m.pricing?.prompt     ? parseFloat(m.pricing.prompt)     * 1_000_000 : undefined;
      const outp = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : undefined;
      return {
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.context_length,
        inputPricePerM:  inp  ? Math.round(inp  * 100) / 100 : undefined,
        outputPricePerM: outp ? Math.round(outp * 100) / 100 : undefined,
        supportsThinking: detectsThinking(m.id),
        supportsVision: true,
        supportsTools: true,
        source: "api" as const,
      };
    });
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

// Pricing/context hardcoded since /v1/models doesn't return it
const OPENAI_META: Record<string, { ctx: number; inp: number; out: number }> = {
  "gpt-4o":                 { ctx: 128000,  inp: 2.50,  out: 10.00 },
  "gpt-4o-mini":            { ctx: 128000,  inp: 0.15,  out: 0.60  },
  "gpt-4-turbo":            { ctx: 128000,  inp: 10.00, out: 30.00 },
  "gpt-4":                  { ctx: 8192,    inp: 30.00, out: 60.00 },
  "gpt-3.5-turbo":          { ctx: 16385,   inp: 0.50,  out: 1.50  },
  "o1":                     { ctx: 200000,  inp: 15.00, out: 60.00 },
  "o1-mini":                { ctx: 128000,  inp: 1.10,  out: 4.40  },
  "o1-preview":             { ctx: 128000,  inp: 15.00, out: 60.00 },
  "o3":                     { ctx: 200000,  inp: 10.00, out: 40.00 },
  "o3-mini":                { ctx: 200000,  inp: 1.10,  out: 4.40  },
  "o4-mini":                { ctx: 200000,  inp: 1.10,  out: 4.40  },
};

const CHAT_MODEL_RE = /^(gpt-4|gpt-3\.5-turbo|o[134])/;

async function fetchOpenAI(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://api.openai.com/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`OpenAI /v1/models returned ${status}`);
  const data = (JSON.parse(body) as { data?: Array<{ id: string }> }).data ?? [];
  return data
    .filter((m) => CHAT_MODEL_RE.test(m.id) && !m.id.includes("instruct") && !m.id.includes("audio"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const meta = OPENAI_META[m.id];
      return {
        id: m.id,
        name: m.id,
        contextLength:    meta?.ctx,
        inputPricePerM:   meta?.inp,
        outputPricePerM:  meta?.out,
        supportsThinking: detectsThinking(m.id),
        supportsVision:   m.id.includes("4o") || m.id.startsWith("o") || m.id.includes("vision"),
        supportsTools:    true,
        source: "api" as const,
      };
    });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function fetchModels(provider: ProviderName, apiKey: string): Promise<ModelInfo[]> {
  switch (provider) {
    case "anthropic":  return fetchAnthropic(apiKey);
    case "openrouter": return fetchOpenRouter(apiKey);
    case "openai":     return fetchOpenAI(apiKey);
    default:           return FALLBACK_MODELS[provider] ?? [];
  }
}

export function getFallbackModels(provider: ProviderName): ModelInfo[] {
  return FALLBACK_MODELS[provider] ?? [];
}
