import { describe, expect, it } from "vitest";
import { sanitizeToolMessages } from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";

describe("sanitizeToolMessages", () => {
  it("passes well-formed tool_use/tool_result pairs through unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "build it" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }] },
    ];
    expect(sanitizeToolMessages(messages)).toEqual(messages);
  });

  it("drops an orphan tool_result whose tool_use was compressed away (the OpenRouter 400)", () => {
    // Simulates a compression boundary that kept the result but summarised away its call.
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_5f60", content: "orphan" }] },
      { role: "assistant", content: "continuing" },
    ];
    expect(sanitizeToolMessages(messages)).toEqual([
      { role: "assistant", content: "continuing" },
    ]);
  });

  it("keeps text blocks while dropping only the orphan tool_result in a mixed message", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "ghost", content: "orphan" },
        { type: "text", text: "and here is more" },
      ] },
    ];
    expect(sanitizeToolMessages(messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "and here is more" }] },
    ]);
  });

  it("synthesizes a result for a tool_use stranded by a cancelled run", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "file_write", input: {} }] },
    ];
    const out = sanitizeToolMessages(messages);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_9" }],
    });
    const result = out[1].content as Array<{ content: string }>;
    expect(JSON.parse(result[0].content)).toMatchObject({ ok: false });
  });

  it("does not synthesize when the tool_use is answered later in the transcript", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "noop", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "done" }] },
    ];
    expect(sanitizeToolMessages(messages)).toEqual(messages);
  });
});
