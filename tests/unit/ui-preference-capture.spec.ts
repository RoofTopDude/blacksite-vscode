/**
 * Capturing a settled visual decision into .blacksite/ui-preferences.json.
 *
 * MemoryStore has carried `upsertUiPreference` and a fully-specified on-disk schema all along,
 * and the file was still `{"preferences": []}` after a session that made a dozen explicit visual
 * choices — because nothing ever called it. The capture therefore hangs off the question_card
 * answer itself rather than off the agent remembering to save something after the fact.
 */
import { describe, expect, it } from "vitest";
import { recordUiPreferenceFromAnswer, uiPreferenceKeyFor } from "../../src/agent-session.js";
import type { QCardQuestion } from "../../src/tools/definitions.js";

const withPreview = (key: string, label: string, description?: string) => ({
  key, label, ...(description ? { description } : {}),
  preview: { code: "document.body.textContent='x'" },
});

function visualQuestion(overrides: Partial<QCardQuestion> = {}): QCardQuestion {
  return {
    question: "Which message bubble treatment?",
    options: [withPreview("flat", "Flat", "No elevation"), withPreview("raised", "Raised")],
    ...overrides,
  };
}

describe("recordUiPreferenceFromAnswer", () => {
  it("records a preview-bearing question the user answered", () => {
    const entry = recordUiPreferenceFromAnswer(visualQuestion({ preferenceKey: "chat.bubble" }), ["raised"]);
    expect(entry).toMatchObject({
      elementKey: "chat.bubble",
      elementType: "question_card",
      selection: { optionId: "raised", optionLabel: "Raised", rationale: "Which message bubble treatment?" },
    });
  });

  /** A scope or sequencing question has no business in a *UI preference* file; the presence of a
   *  preview is the harness's own signal that the fork was about how something looks. */
  it("ignores a question with no previews", () => {
    const prose: QCardQuestion = {
      question: "Ship now or batch with the next release?",
      options: [{ key: "now", label: "Now" }, { key: "batch", label: "Batch" }],
    };
    expect(recordUiPreferenceFromAnswer(prose, ["now"])).toBeNull();
  });

  it("ignores a declined question", () => {
    expect(recordUiPreferenceFromAnswer(visualQuestion(), [])).toBeNull();
  });

  it("ignores a selection naming an option that does not exist", () => {
    expect(recordUiPreferenceFromAnswer(visualQuestion(), ["ghost"])).toBeNull();
  });

  it("records every choice of a multi-select", () => {
    const entry = recordUiPreferenceFromAnswer(visualQuestion({ multiSelect: true }), ["flat", "raised"]);
    expect(entry?.selection).toMatchObject({ optionId: "flat,raised", optionLabel: "Flat, Raised" });
  });

  it("keeps option descriptions as notes, since they carry the reasoning shown to the user", () => {
    expect(recordUiPreferenceFromAnswer(visualQuestion(), ["flat"])?.technicalDetails)
      .toEqual({ notes: ["No elevation"] });
  });

  it("omits technicalDetails entirely when there is nothing to say", () => {
    expect(recordUiPreferenceFromAnswer(visualQuestion(), ["raised"])).not.toHaveProperty("technicalDetails");
  });
});

describe("uiPreferenceKeyFor", () => {
  it("prefers the agent-supplied key", () => {
    expect(uiPreferenceKeyFor(visualQuestion({ preferenceKey: "runs.timeline-density" }))).toBe("runs.timeline-density");
  });

  /** Without a key the answer is still worth keeping — it just dedupes on wording instead of
   *  identity, which is enough for the same question being asked again later. */
  it("falls back to a slug of the question text", () => {
    expect(uiPreferenceKeyFor(visualQuestion())).toBe("which-message-bubble-treatment");
  });

  it("is stable across repeats of the same question, so the answer supersedes rather than stacks", () => {
    expect(uiPreferenceKeyFor(visualQuestion())).toBe(uiPreferenceKeyFor(visualQuestion()));
  });

  it("never yields an empty key", () => {
    expect(uiPreferenceKeyFor(visualQuestion({ question: "???" }))).toBe("unnamed-choice");
  });

  it("ignores a blank agent-supplied key rather than keying everything on empty string", () => {
    expect(uiPreferenceKeyFor(visualQuestion({ preferenceKey: "   " }))).toBe("which-message-bubble-treatment");
  });
});
