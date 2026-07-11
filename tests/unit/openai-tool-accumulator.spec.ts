import { describe, expect, it } from "vitest";
import { OpenAIToolCallAccumulator } from "../../src/agent-session.js";

function feed(fragments: Array<Record<string, unknown>>) {
  const acc = new OpenAIToolCallAccumulator();
  for (const f of fragments) acc.push(f);
  return acc.finish();
}

describe("OpenAIToolCallAccumulator", () => {
  it("assembles a standard OpenAI streamed call (index + id/name first, args appended)", () => {
    const blocks = feed([
      { index: 0, id: "call_1", function: { name: "file_read", arguments: "" } },
      { index: 0, function: { arguments: '{"path":' } },
      { index: 0, function: { arguments: '"a.ts"}' } },
    ]);
    expect(blocks).toEqual([{ type: "tool_use", id: "call_1", name: "file_read", input: { path: "a.ts" } }]);
  });

  it("keeps two parallel indexed calls separate (the case the old index-0 collapse corrupted)", () => {
    const blocks = feed([
      { index: 0, id: "call_a", function: { name: "file_read", arguments: "" } },
      { index: 1, id: "call_b", function: { name: "file_list", arguments: "" } },
      { index: 0, function: { arguments: '{"path":"a"}' } },
      { index: 1, function: { arguments: '{"path":"b"}' } },
    ]);
    expect(blocks).toEqual([
      { type: "tool_use", id: "call_a", name: "file_read", input: { path: "a" } },
      { type: "tool_use", id: "call_b", name: "file_list", input: { path: "b" } },
    ]);
  });

  it("handles an index-less provider by appending arg fragments to the in-progress call", () => {
    const blocks = feed([
      { id: "call_x", function: { name: "shell_run", arguments: '{"comm' } },
      { function: { arguments: 'and":"ls"}' } },
    ]);
    expect(blocks).toEqual([{ type: "tool_use", id: "call_x", name: "shell_run", input: { command: "ls" } }]);
  });

  it("delimits two index-less calls by their id boundaries", () => {
    const blocks = feed([
      { id: "call_1", function: { name: "file_read", arguments: '{"path":"a"}' } },
      { id: "call_2", function: { name: "file_read", arguments: '{"path":"b"}' } },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ id: "call_1", input: { path: "a" } });
    expect(blocks[1]).toMatchObject({ id: "call_2", input: { path: "b" } });
  });

  it("synthesizes an id when a provider never supplies one (needed for tool_result pairing)", () => {
    const blocks = feed([
      { index: 0, function: { name: "file_list", arguments: "{}" } },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBeTruthy();
    expect(blocks[0]).toMatchObject({ name: "file_list", input: {} });
  });

  it("tolerates a numeric-string index", () => {
    const blocks = feed([
      { index: "0", id: "c0", function: { name: "a", arguments: "{}" } },
      { index: "1", id: "c1", function: { name: "b", arguments: "{}" } },
    ]);
    expect(blocks.map((b) => b.id)).toEqual(["c0", "c1"]);
  });

  it("drops a fragment that arrives before any call and carries no id", () => {
    const blocks = feed([
      { function: { arguments: "orphan-args" } },
      { index: 0, id: "c1", function: { name: "file_read", arguments: '{"path":"a"}' } },
    ]);
    expect(blocks).toEqual([{ type: "tool_use", id: "c1", name: "file_read", input: { path: "a" } }]);
  });

  it("yields empty input (not a crash) when the streamed argument JSON is truncated", () => {
    const blocks = feed([
      { index: 0, id: "c1", function: { name: "file_write", arguments: '{"path":"a","content":"unterminated' } },
    ]);
    expect(blocks).toEqual([{ type: "tool_use", id: "c1", name: "file_write", input: {} }]);
  });

  it("drops a call that never received a function name", () => {
    const blocks = feed([
      { index: 0, function: { arguments: "{}" } },
    ]);
    expect(blocks).toEqual([]);
  });
});
