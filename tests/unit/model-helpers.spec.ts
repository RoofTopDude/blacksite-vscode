import { describe, expect, it } from "vitest";
import { findModelByQuery, modelShortLabel } from "../../src/webview/react/components/settings/helpers.js";
import type { ModelInfo } from "../../src/webview/react/lib/protocol.js";

const MODELS: ModelInfo[] = [
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextLength: 200000 },
  { id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", contextLength: 200000 },
  { id: "openai/gpt-5", name: "GPT-5", contextLength: 400000 },
  { id: "openai/gpt-4o", name: "GPT-4o", contextLength: 128000 },
];

describe("modelShortLabel", () => {
  it("drops the provider prefix", () => {
    expect(modelShortLabel("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
  it("prefers the display name from a ModelInfo", () => {
    expect(modelShortLabel(MODELS[0])).toBe("Claude Sonnet 4.6");
  });
  it("handles bare ids and empties", () => {
    expect(modelShortLabel("gpt-4o")).toBe("gpt-4o");
    expect(modelShortLabel("")).toBe("");
    expect(modelShortLabel(undefined)).toBe("");
  });
});

describe("findModelByQuery", () => {
  it("matches on a trailing id segment", () => {
    expect(findModelByQuery(MODELS, "gpt-5")?.id).toBe("openai/gpt-5");
  });
  it("matches a display-name substring", () => {
    expect(findModelByQuery(MODELS, "opus")?.id).toBe("anthropic/claude-opus-4-8");
  });
  it("prefers exact over substring", () => {
    // "gpt-5" is a substring of "gpt-4o"? no; but ensure exact id wins over other partials
    expect(findModelByQuery(MODELS, "openai/gpt-5")?.id).toBe("openai/gpt-5");
  });
  it("returns null when nothing matches", () => {
    expect(findModelByQuery(MODELS, "gemini")).toBeNull();
    expect(findModelByQuery(MODELS, "")).toBeNull();
  });
});
