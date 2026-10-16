/* Evaluation inputs are synthetic. This keeps them that way: nothing that looks like a person's
   email, a home directory, or a credential may appear in a trace, a golden file or a fixture. */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { EVAL_ROOT } from "../harness/run-scenarios.js";

const PATTERNS: Array<[string, RegExp]> = [
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["Windows home directory", /[A-Za-z]:[\\/]+Users[\\/]+[^\\/"\s]+/i],
  ["Unix home directory", /\/(home|Users)\/[A-Za-z0-9._-]+\//],
  ["API key", /\b(sk-[A-Za-z0-9-]{16,}|sk-ant-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,})\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

const inputs = ["traces", "golden", "fixtures"].flatMap((name) => files(path.join(EVAL_ROOT, name)));

describe("evaluation inputs are sanitized", () => {
  it("has inputs to check", () => {
    expect(inputs.length).toBeGreaterThan(0);
  });

  it.each(inputs.map((file) => [path.relative(EVAL_ROOT, file).replace(/\\/g, "/"), file] as const))("%s", (_name, file) => {
    const text = fs.readFileSync(file, "utf8");
    for (const [label, pattern] of PATTERNS) expect(pattern.test(text), `${label} in ${file}`).toBe(false);
  });
});
