import { describe, expect, it } from "vitest";
import { extractReporterJson } from "../../../../packages/local-runtime/src/test-harness.js";

// Regression for "Could not parse test output": with --reporter=json AND
// --reporter=default both active, the default reporter's decorative output (which
// contains '{') precedes the JSON, so a naive indexOf("{") slice fails to parse.
describe("extractReporterJson", () => {
  it("carves the JSON object out of mixed reporter output", () => {
    const mixed = [
      "[36m RUN [39m v4.1.5",
      " { decorative banner with a brace }",
      '{"numPassedTests":8,"numFailedTests":0,"testResults":[]}',
      "Test Files  1 passed (1)",
    ].join("\n");
    const json = extractReporterJson(mixed);
    const parsed = JSON.parse(json) as { numPassedTests: number };
    expect(parsed.numPassedTests).toBe(8);
  });

  it("returns empty string when there is no JSON object", () => {
    expect(extractReporterJson("no json here")).toBe("");
  });
});
