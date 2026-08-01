/**
 * The preview-authoring surface the agent actually reads.
 *
 * The agent cannot use a capability it is not told about, and the whole reason previews came back
 * as sketches is that the tool description advertised a blank canvas. These assertions pin the
 * three affordances that make a preview a prototype — the project's real classes, the real
 * component, and a look at the result — to the schema rather than to a docs page nobody loads.
 */
import { describe, expect, it } from "vitest";
import { UI_TOOLS, resolveToolDispatch, validateToolInput } from "../../src/tools/definitions.js";

const byName = (name: string) => UI_TOOLS.find((tool) => tool.name === name);
const questionCard = byName("question_card")!;
const designTokens = byName("ui_design_tokens")!;
const previewRender = byName("ui_preview_render")!;

const previewSchema = (questionCard.input_schema.properties as Record<string, any>)
  .questions.items.properties.options.items.properties.preview;

describe("question_card preview schema", () => {
  it("accepts a mount alongside code", () => {
    expect(Object.keys(previewSchema.properties)).toEqual(
      expect.arrayContaining(["html", "code", "mount", "height", "expandHint"]),
    );
  });

  /** Previously `code` was required, which made "render the real component" unexpressible. */
  it("no longer forces code, so a mount-only preview is valid", () => {
    expect(previewSchema.required ?? []).not.toContain("code");
  });

  it("requires an entry on a mount — there is nothing to render without one", () => {
    expect(previewSchema.properties.mount.required).toEqual(["entry"]);
  });

  it("requires file/find/replace on every patch, so an edit cannot be half-specified", () => {
    expect(previewSchema.properties.mount.properties.patch.items.required)
      .toEqual(["file", "find", "replace"]);
  });

  it("tells the agent the patch is applied in memory, not to the working tree", () => {
    expect(previewSchema.properties.mount.description).toMatch(/in memory/i);
    expect(previewSchema.properties.mount.description).toMatch(/never modified|working tree/i);
  });

  /** A `find` copied approximately fails the build; saying so up front is cheaper than a retry. */
  it("warns that find must be verbatim", () => {
    expect(previewSchema.properties.mount.properties.patch.items.properties.find.description)
      .toMatch(/verbatim/i);
  });

  it("points the agent at ui_design_tokens before it starts authoring", () => {
    expect(questionCard.description).toContain("ui_design_tokens");
  });

  it("points the agent at ui_preview_render before it sends", () => {
    expect(questionCard.description).toContain("ui_preview_render");
  });

  it("says the project stylesheet is already loaded, which is the reason not to hand-roll CSS", () => {
    expect(questionCard.description).toMatch(/compiled stylesheet is already loaded/i);
  });

  it("still warns against hardcoded hex, which breaks in the other theme", () => {
    expect(questionCard.description).toMatch(/hardcoded hex/i);
  });

  it("asks advanced preference questions instead of cosmetic variants", () => {
    expect(questionCard.description).toMatch(/altitude of the consequential decision/i);
    expect(questionCard.description).toMatch(/materially different product, experience, visual, and technical consequences/i);
    expect(questionCard.description).toMatch(/never offer several cosmetic variants/i);
  });

  it("treats 2D and 3D as first-class render targets with a production quality floor", () => {
    expect(questionCard.description).toContain("Canvas 2D");
    expect(questionCard.description).toContain("WebGL/WebGPU");
    expect(questionCard.description).toMatch(/geometry, camera, lighting, materials, depth, motion/i);
    expect(questionCard.description).toMatch(/do not lower the proposal's ambition/i);
  });

  it("requires project grounding instead of applying Blacksite or a generic dashboard aesthetic", () => {
    expect(questionCard.description).toMatch(/Ground the previews in this project/i);
    expect(questionCard.description).toMatch(/generic dashboard/i);
    expect(designTokens.description).toMatch(/never as permission to make an unrelated project look like Blacksite/i);
  });

  it("gives complex scenes enough comparison-stage height", () => {
    expect(previewSchema.properties.height.description).toMatch(/420-900/);
    expect(previewSchema.properties.height.description).toMatch(/respects heights up to 900/i);
  });
});

describe("ui_design_tokens", () => {
  it("dispatches to its own runtime type", () => {
    expect(designTokens.runtimeType).toBe("ui.design_tokens");
  });

  it("takes no required arguments — the common call is the bare one", () => {
    expect(designTokens.input_schema.required ?? []).toEqual([]);
  });

  it("offers a filter, so a specific class can be confirmed rather than assumed absent", () => {
    expect(designTokens.input_schema.properties).toHaveProperty("filter");
  });

  /** Which design system the agent is drawing with changes whether the preview is faithful or
   *  actively misleading, so the origin has to be explained, not just returned. */
  it("explains what origin means, including the misleading case", () => {
    expect(designTokens.description).toMatch(/workspace/);
    expect(designTokens.description).toMatch(/extension/);
    expect(designTokens.description).toMatch(/none/);
  });

  it("warns that guessing class names renders unstyled", () => {
    expect(designTokens.description).toMatch(/unstyled/i);
  });
});

describe("ui_preview_render", () => {
  it("dispatches to its own runtime type", () => {
    expect(previewRender.runtimeType).toBe("ui.preview_render");
  });

  it("takes the same payload as a question_card preview, so the rehearsal matches the real thing", () => {
    expect(Object.keys(previewRender.input_schema.properties)).toEqual(
      expect.arrayContaining(["code", "html", "mount", "width", "height", "settleMs"]),
    );
  });

  it("says what to do when the browser runtime is missing rather than leaving it undefined", () => {
    expect(previewRender.description).toMatch(/unavailable/i);
  });

  it("frames rendering as a precondition, not an option", () => {
    expect(previewRender.description).toMatch(/before/i);
  });

  it("requires visual inspection and iteration, not merely a successful tool result", () => {
    expect(previewRender.description).toMatch(/inspect the image rather than merely checking `ok`/i);
    expect(previewRender.description).toMatch(/visually lazy render is not done/i);
    expect(previewRender.description).toMatch(/3D geometry\/camera\/lighting\/material readability/i);
  });
});

describe("dispatch and validation", () => {
  it("resolves both new tools by name", () => {
    expect(resolveToolDispatch("ui_design_tokens")?.runtimeType).toBe("ui.design_tokens");
    expect(resolveToolDispatch("ui_preview_render")?.runtimeType).toBe("ui.preview_render");
  });

  it("accepts a mount-only preview through input validation", () => {
    const issues = validateToolInput("question_card", {
      questions: [{
        question: "Which spacing?",
        options: [{
          key: "tight",
          label: "Tight",
          preview: { mount: { entry: "src/Card.tsx", patch: [{ file: "src/Card.tsx", find: "p-4", replace: "p-2" }] } },
        }],
      }],
    });
    expect(issues).toEqual([]);
  });

  it("accepts a code-only preview, which non-existent UI still needs", () => {
    const issues = validateToolInput("question_card", {
      questions: [{
        question: "Which layout?",
        options: [{ key: "a", label: "A", preview: { code: "document.body.textContent='x'" } }],
      }],
    });
    expect(issues).toEqual([]);
  });

  it("rejects a mount whose entry is missing from the call", () => {
    const issues = validateToolInput("ui_preview_render", { mount: { export: "Button" } });
    expect(issues.length).toBeGreaterThan(0);
  });
});
