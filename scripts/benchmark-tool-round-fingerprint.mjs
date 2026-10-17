// Run with: node --experimental-strip-types scripts/benchmark-tool-round-fingerprint.mjs
// Synthetic data; measures parse + normalize + canonicalize + SHA-256, not provider/runtime time.
import { performance } from "node:perf_hooks";
import { toolRoundFingerprint } from "../src/orchestration/tool-round-fingerprint.ts";

for (const count of [10, 100, 1000]) {
  const calls = [{ type: "tool_use", id: "test", name: "generic_tool", input: {} }];
  const content = JSON.stringify({ ok: false, durationMs: 123, verification: { status: "failed", updatedAt: 1800000000000 },
    failures: Array.from({ length: count }, (_, i) => ({ name: `case-${i}`, message: "expected 2, received 1", elapsedMs: i })) });
  const results = [{ type: "tool_result", tool_use_id: "test", content }];
  for (let i = 0; i < 200; i++) toolRoundFingerprint(calls, results);
  const samples = [];
  for (let batch = 0; batch < 9; batch++) {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) toolRoundFingerprint(calls, results);
    samples.push((performance.now() - start) / 1000);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ bytes: Buffer.byteLength(content), iterations: 9000, medianMsPerRound: samples[4], maxBatchMsPerRound: samples[8] }));
}
