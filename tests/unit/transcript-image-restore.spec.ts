import { describe, expect, it } from "vitest";
import {
  PERSISTED_IMAGE_STUB,
  restorePersistedImages,
  stripImagesForPersistence,
} from "../../src/agent/transcript-hygiene.js";
import type { AgentMessage, ImageBlock } from "../../src/agent-loop-contract.js";

const IMAGE: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const OTHER: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } };

describe("restorePersistedImages", () => {
  it("round-trips a transcript through persistence without losing its images", () => {
    const live: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "look" }, IMAGE] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "file_read", input: { path: "a.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }, OTHER] },
    ];
    expect(restorePersistedImages(stripImagesForPersistence(live), live)).toEqual(live);
  });

  it("only touches a message whose persisted form matches the live one at the same position", () => {
    const live: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "look" }, IMAGE] }];
    const edited: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "look again" }, { type: "text", text: PERSISTED_IMAGE_STUB }] }];
    expect(restorePersistedImages(edited, live)).toBe(edited);
  });

  it("keeps the store's redaction of browser results while restoring the screenshot beside them", () => {
    const live: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "browser_screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "{\"secret\":\"page text\"}" }, IMAGE] },
    ];
    const restored = restorePersistedImages(stripImagesForPersistence(live), live);
    const blocks = restored[1]!.content as Array<{ type: string; content?: string }>;
    expect(blocks[0]!.content).not.toContain("page text");
    expect(blocks[1]).toEqual(IMAGE);
  });

  it("returns the stored array itself when there is nothing to restore", () => {
    const stored: AgentMessage[] = [{ role: "user", content: "hello" }];
    expect(restorePersistedImages(stored, [])).toBe(stored);
    expect(restorePersistedImages(stored, stored)).toBe(stored);
  });
});
