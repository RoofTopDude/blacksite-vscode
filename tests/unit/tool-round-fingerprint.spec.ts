import { expect, it } from "vitest";
import { toolRoundFingerprint } from "../../src/orchestration/tool-round-fingerprint.js";

function fingerprint(result: unknown, input: unknown = {}) {
  return toolRoundFingerprint([{ type: "tool_use", id: "ignored", name: "generic_tool", input }],
    [{ type: "tool_result", tool_use_id: "ignored", content: JSON.stringify(result) }]);
}

it.each(["durationMs", "elapsedMs", "updatedAt", "created_at", "startedAt", "finishedAt", "checkedAt", "timestamp"])("ignores nested metadata %s", (key) => {
  expect(fingerprint({ items: [{ [key]: 1, status: "failed" }] }))
    .toBe(fingerprint({ items: [{ [key]: 2, status: "failed" }] }));
});

it.each(["status", "failed", "contentHash", "sourceRevision", "expiresAt", "path", "error"])("retains meaningful result field %s", (key) => {
  expect(fingerprint({ [key]: "before" })).not.toBe(fingerprint({ [key]: "after" }));
});

it("retains timestamp arguments, source contents and stdout", () => {
  expect(fingerprint({}, { updatedAt: 1 })).not.toBe(fingerprint({}, { updatedAt: 2 }));
  expect(fingerprint({ content: '{"updatedAt":1}' })).not.toBe(fingerprint({ content: '{"updatedAt":2}' }));
  expect(fingerprint({ stdout: "timestamp: 1" })).not.toBe(fingerprint({ stdout: "timestamp: 2" }));
});

it("ignores a test runner's start time and duration in its raw output, and nothing else in it", () => {
  // Real vitest output: the same two failures, run a minute apart.
  const run = (start: string, duration: string, extra = "") => fingerprint({
    ok: false, passed: 3, failed: 2, failures: [{ test: "parses tables", message: "expected 2, received 1" }],
    rawOutput: `\u001b[1m RUN \u001b[22m v4.1.11\n FAIL parses tables${extra}\n Test Files 1 failed\n   Start at ${start}\n   Duration ${duration} (transform 1.17s)`,
  });
  expect(run("20:33:36", "1.68s")).toBe(run("20:34:51", "2.03s"));
  expect(run("20:33:36", "1.68s")).toBe(run("2026-10-16T20:35:00Z", "950ms"));
  // A different line of output is different evidence.
  expect(run("20:33:36", "1.68s")).not.toBe(run("20:33:36", "1.68s", "\n console.log: retrying"));
});

it("canonicalizes JSON property order without changing array order", () => {
  expect(fingerprint({ a: 1, b: 2 }, { c: 3, d: 4 })).toBe(fingerprint({ b: 2, a: 1 }, { d: 4, c: 3 }));
  expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
});

it("retains plain text and malformed JSON exactly", () => {
  const call = { type: "tool_use" as const, id: "one", name: "generic_tool", input: {} };
  const raw = (content: string) => toolRoundFingerprint([call], [{ type: "tool_result", tool_use_id: call.id, content }]);
  expect(raw("{broken updatedAt:1")).not.toBe(raw("{broken updatedAt:2"));
  expect(raw("first failure")).not.toBe(raw("second failure"));
});
