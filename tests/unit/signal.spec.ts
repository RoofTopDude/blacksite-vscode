import { describe, expect, it } from "vitest";
import {
  TONE_COLOR_VAR, overviewTone, toneColor, toneStyle, toolStateTone, turnStatusTone,
  type SignalTone,
} from "../../src/webview/react/components/chat/signal.js";

describe("toolStateTone", () => {
  it("maps every tool state to a tone", () => {
    expect(toolStateTone("ok")).toBe("ok");
    expect(toolStateTone("fail")).toBe("err");
    expect(toolStateTone("pending")).toBe("warn");
    expect(toolStateTone("running")).toBe("info");
  });
});

describe("turnStatusTone", () => {
  it("maps chrome status classes", () => {
    expect(turnStatusTone("streaming")).toBe("info");
    expect(turnStatusTone("pending")).toBe("warn");
    expect(turnStatusTone("limit")).toBe("warn");
    expect(turnStatusTone("error")).toBe("err");
    expect(turnStatusTone("complete")).toBe("ok");
  });
  it("falls back to idle for unknown classes", () => {
    expect(turnStatusTone("whatever")).toBe("idle");
  });
});

describe("overviewTone", () => {
  it("maps the overview pill vocabulary", () => {
    expect(overviewTone("live")).toBe("info");
    expect(overviewTone("wait")).toBe("warn");
    expect(overviewTone("limit")).toBe("warn");
    expect(overviewTone("error")).toBe("err");
    expect(overviewTone("done")).toBe("ok");
    expect(overviewTone("idle")).toBe("idle");
    expect(overviewTone("")).toBe("idle");
  });
});

describe("toneColor / toneStyle", () => {
  const tones: SignalTone[] = ["idle", "info", "ok", "warn", "err"];

  it("returns the backing theme variable for each tone", () => {
    for (const tone of tones) {
      expect(toneColor(tone)).toBe(TONE_COLOR_VAR[tone]);
    }
  });

  it("builds a color/fill/border style derived from the tone color", () => {
    const style = toneStyle("ok");
    expect(style.color).toBe("var(--s-ok)");
    expect(style.background).toContain("var(--s-ok)");
    expect(style.background).toContain("color-mix");
    expect(style.borderColor).toContain("var(--s-ok)");
  });
});
