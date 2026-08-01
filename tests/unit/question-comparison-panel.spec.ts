import { describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { QuestionComparisonPanel } from "../../src/question-comparison-panel.js";

function comparisonHtml(): string {
  const panel = new QuestionComparisonPanel(
    { extensionUri: Uri.file("/extension-without-assets") } as never,
    () => undefined,
  );
  return (panel as unknown as {
    _html(webview: { cspSource: string }, toolCallId: string, questions: unknown[]): string;
  })._html(
    { cspSource: "vscode-webview:" },
    "question-1",
    [{
      question: "Which world direction?",
      options: [
        { key: "a", label: "Atmospheric", preview: { code: "document.body.textContent='A'", height: 760 } },
        { key: "b", label: "Graphic", preview: { code: "document.body.textContent='B'", height: 640 } },
      ],
    }],
  );
}

describe("QuestionComparisonPanel visual stage", () => {
  it("emits syntactically valid comparison-stage JavaScript", () => {
    const scripts = [...comparisonHtml().matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
    const stageScript = scripts.at(-1)?.[1];
    expect(stageScript).toBeTruthy();
    expect(() => new Function(stageScript!)).not.toThrow();
  });

  it("opens visual evidence by default and offers a full-width focus mode", () => {
    const html = comparisonHtml();
    expect(html).toContain("Visual evidence is open by default");
    expect(html).toContain("details.open = true");
    expect(html).toContain("Focus full width");
    expect(html).toContain("Return to comparison");
    expect(html).toContain("options.classList.toggle('focus-mode', focus)");
    expect(html).toContain("!details.open && card.classList.contains('focused')");
  });

  it("uses an adaptive visual grid and preserves complex preview heights up to 900px", () => {
    const html = comparisonHtml();
    expect(html).toContain(".options.visual");
    expect(html).toContain("Math.min(Math.round(requested), 900)");
    expect(html).toContain("window.innerHeight - 260");
    expect(html).toContain("IntersectionObserver");
    expect(html).toContain("rootMargin: '320px 0px'");
  });

  it("keeps imported visual assets local while allowing data/blob resources in the sandbox", () => {
    const html = comparisonHtml();
    expect(html).toContain("font-src data: blob:");
    expect(html).toContain("media-src data: blob:");
    expect(html).toContain("connect-src data: blob:");
    expect(html).toContain("worker-src blob:");
    expect(html).not.toContain("connect-src https:");
  });
});
