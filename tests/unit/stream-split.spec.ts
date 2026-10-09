import { describe, expect, it } from "vitest";
import { splitStreaming } from "../../src/webview/react/lib/stream-split.js";

describe("splitStreaming", () => {
  it("keeps everything as open text until a first block is finished", () => {
    expect(splitStreaming("")).toEqual({ stable: "", tail: "" });
    expect(splitStreaming("A sentence that is still being wr")).toEqual({ stable: "", tail: "A sentence that is still being wr" });
    expect(splitStreaming("One paragraph.\n")).toEqual({ stable: "", tail: "One paragraph.\n" });
  });

  it("finishes every block up to the last blank line and leaves the rest open", () => {
    const raw = "# Title\n\nFirst paragraph.\n\nSecond para";
    const { stable, tail } = splitStreaming(raw);
    expect(stable).toBe("# Title\n\nFirst paragraph.\n\n");
    expect(tail).toBe("Second para");
    expect(stable + tail).toBe(raw);
  });

  it("never splits inside a fenced code block, even across blank lines", () => {
    const raw = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
    const { stable, tail } = splitStreaming(raw);
    expect(stable).toBe("Intro.\n\n");
    expect(tail).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n");
  });

  it("finishes a code block once its closing fence arrives", () => {
    const raw = "Intro.\n\n```ts\nconst a = 1;\n```\n\nAfter";
    const { stable, tail } = splitStreaming(raw);
    expect(stable).toBe("Intro.\n\n```ts\nconst a = 1;\n```\n\n");
    expect(tail).toBe("After");
  });

  it("understands longer fences and tildes", () => {
    const raw = "Text.\n\n````md\n```\ninner\n```\n\nstill inside\n````\n\nDone\n\nOpen";
    const { stable, tail } = splitStreaming(raw);
    expect(stable.endsWith("````\n\nDone\n\n")).toBe(true);
    expect(tail).toBe("Open");
    expect(splitStreaming("a\n\n~~~\nx\n\ny").tail).toBe("~~~\nx\n\ny");
  });

  it("always hands back exactly what it was given", () => {
    const samples = ["", "\n\n", "a\n\nb\n\n", "a\n\n```\nb\n\n", "x\n\n\n\ny", "line\r\n\r\nnext"];
    for (const raw of samples) {
      const { stable, tail } = splitStreaming(raw);
      expect(stable + tail).toBe(raw);
    }
  });
});
