import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Extract the reporter JSON object from mixed stdout. With `--reporter=json` and
 * `--reporter=default` both active, the default reporter's decorative output (which
 * can contain `{` characters) surrounds the JSON, so a naive `indexOf("{")` slice
 * fails to parse — the cause of the "Could not parse test output" failures in the
 * logs. Scan each `{` and return the first that opens a balanced, parseable object.
 */
export function extractReporterJson(stdout: string): string {
  for (let i = stdout.indexOf("{"); i >= 0; i = stdout.indexOf("{", i + 1)) {
    const candidate = sliceBalancedObject(stdout, i);
    if (candidate) {
      try { JSON.parse(candidate); return candidate; } catch { /* not the JSON report; keep scanning */ }
    }
  }
  return "";
}

/** Slice the balanced `{…}` span starting at `start`, honouring string literals, or null if unbalanced. */
function sliceBalancedObject(s: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export type TestFramework = "jest" | "vitest" | "pytest" | "go" | "unknown";

export interface TestFailure {
  test: string;
  message: string;
  location?: string;
}

export interface TestResult {
  ok: boolean;
  framework: TestFramework;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  rawOutput: string;
  durationMs: number;
}

export interface TestRunOptions {
  filter?: string;
  timeoutMs?: number;
  cwd?: string;
}

// ── Framework detection ────────────────────────────────────────────────────────

export function detectFramework(root: string): TestFramework {
  const has = (f: string) => fs.existsSync(path.join(root, f));

  // Go
  if (has("go.mod")) return "go";

  // pytest
  if (has("pytest.ini") || has("setup.cfg")) return "pytest";
  if (has("pyproject.toml")) {
    try {
      const txt = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8");
      if (txt.includes("[tool.pytest") || txt.includes("[tool.pytest.ini_options]")) return "pytest";
    } catch { /* ignore */ }
  }

  // vitest (check before jest — vitest configs are unambiguous)
  for (const f of ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"]) {
    if (has(f)) return "vitest";
  }

  // jest
  for (const f of ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"]) {
    if (has(f)) return "jest";
  }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        jest?: unknown; scripts?: Record<string, string>;
      };
      if (pkg.jest) return "jest";
      const test = pkg.scripts?.["test"] ?? "";
      if (test.includes("jest")) return "jest";
      if (test.includes("vitest")) return "vitest";
    } catch { /* ignore */ }
  }

  return "unknown";
}

// ── Test execution ─────────────────────────────────────────────────────────────

export function runTests(root: string, opts: TestRunOptions = {}): TestResult {
  const framework = detectFramework(root);
  const cwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = Date.now();

  switch (framework) {
    case "jest":    return _runJest(cwd, framework, opts.filter, timeoutMs, start);
    case "vitest":  return _runVitest(cwd, framework, opts.filter, timeoutMs, start);
    case "pytest":  return _runPytest(cwd, framework, opts.filter, timeoutMs, start);
    case "go":      return _runGo(cwd, framework, opts.filter, timeoutMs, start);
    default:        return _unknownFramework(root, start);
  }
}

// ── Jest ───────────────────────────────────────────────────────────────────────

function _runJest(cwd: string, fw: TestFramework, filter: string | undefined, timeout: number, start: number): TestResult {
  const args = ["jest", "--json", "--passWithNoTests", "--no-coverage"];
  if (filter) args.push("--testPathPattern", filter);

  const res = spawnSync("npx", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = (res.stdout ?? "") + (res.stderr ?? "");

  // Jest writes JSON to stdout even on failure. Carve out the JSON object so any
  // leading/trailing non-JSON (verbose output, deprecation notices) can't break parse.
  const jsonStr = extractReporterJson(res.stdout ?? "") || (res.stdout ?? "");

  try {
    const j = JSON.parse(jsonStr) as {
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{
        testFilePath?: string;
        testResults?: Array<{ fullName?: string; status?: string; failureMessages?: string[] }>;
      }>;
    };
    const failures: TestFailure[] = [];
    for (const suite of j.testResults ?? []) {
      for (const t of suite.testResults ?? []) {
        if (t.status === "failed") {
          failures.push({
            test: t.fullName ?? "(unknown)",
            message: (t.failureMessages ?? []).join("\n").slice(0, 2000),
            location: suite.testFilePath,
          });
        }
      }
    }
    return {
      ok: (j.numFailedTests ?? 0) === 0,
      framework: fw,
      passed: j.numPassedTests ?? 0,
      failed: j.numFailedTests ?? 0,
      skipped: j.numPendingTests ?? 0,
      failures,
      rawOutput: raw.slice(0, 32_000),
      durationMs: Date.now() - start,
    };
  } catch {
    return _failedRun(fw, raw, start);
  }
}

// ── Vitest ─────────────────────────────────────────────────────────────────────

function _runVitest(cwd: string, fw: TestFramework, filter: string | undefined, timeout: number, start: number): TestResult {
  // Write the JSON report to a file so it can never be polluted by the default
  // reporter's interleaved, ANSI-coloured output on stdout (the historical cause of
  // "Could not parse test output"). Keep the default reporter for human-readable raw.
  const outFile = path.join(os.tmpdir(), `bs-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`, "--reporter=default"];
  if (filter) args.push(filter);

  const res = spawnSync("npx", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = (res.stdout ?? "") + (res.stderr ?? "");

  // Prefer the JSON file; fall back to carving the JSON object out of stdout.
  let jsonStr = "";
  try { jsonStr = fs.readFileSync(outFile, "utf8"); } catch { /* file may not exist on crash */ }
  finally { try { fs.unlinkSync(outFile); } catch { /* best-effort cleanup */ } }
  if (!jsonStr.trim()) jsonStr = extractReporterJson(res.stdout ?? "");

  try {
    const j = JSON.parse(jsonStr) as {
      numPassedTests?: number; numFailedTests?: number; numPendingTests?: number;
      testResults?: Array<{
        name?: string;
        assertionResults?: Array<{ fullName?: string; status?: string; failureMessages?: string[] }>;
      }>;
    };
    const failures: TestFailure[] = [];
    for (const suite of j.testResults ?? []) {
      for (const t of suite.assertionResults ?? []) {
        if (t.status === "failed") {
          failures.push({
            test: t.fullName ?? "(unknown)",
            message: (t.failureMessages ?? []).join("\n").slice(0, 2000),
            location: suite.name,
          });
        }
      }
    }
    return {
      ok: (j.numFailedTests ?? 0) === 0,
      framework: fw,
      passed: j.numPassedTests ?? 0,
      failed: j.numFailedTests ?? 0,
      skipped: j.numPendingTests ?? 0,
      failures,
      rawOutput: raw.slice(0, 32_000),
      durationMs: Date.now() - start,
    };
  } catch {
    return _failedRun(fw, raw, start);
  }
}

// ── Pytest ─────────────────────────────────────────────────────────────────────

function _runPytest(cwd: string, fw: TestFramework, filter: string | undefined, timeout: number, start: number): TestResult {
  const args = ["-m", "pytest", "--tb=short", "-q"];
  if (filter) args.push("-k", filter);

  const res = spawnSync("python", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = ((res.stdout ?? "") + (res.stderr ?? "")).slice(0, 32_000);

  return _parsePytest(raw, fw, start);
}

function _parsePytest(raw: string, fw: TestFramework, start: number): TestResult {
  // Summary line: "5 passed, 2 failed, 1 skipped" or "2 failed"
  const summary = raw.match(/(\d+)\s+passed|(\d+)\s+failed|(\d+)\s+skipped/g) ?? [];
  let passed = 0, failed = 0, skipped = 0;
  for (const m of summary) {
    const n = parseInt(m);
    if (m.includes("passed"))  passed  = n;
    if (m.includes("failed"))  failed  = n;
    if (m.includes("skipped")) skipped = n;
  }

  // FAILED lines: "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
  const failures: TestFailure[] = [];
  const failRe = /^FAILED (.+?) - (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(raw)) !== null) {
    failures.push({ test: m[1] ?? "", message: m[2] ?? "" });
  }

  return { ok: failed === 0, framework: fw, passed, failed, skipped, failures, rawOutput: raw, durationMs: Date.now() - start };
}

// ── Go ─────────────────────────────────────────────────────────────────────────

function _runGo(cwd: string, fw: TestFramework, filter: string | undefined, timeout: number, start: number): TestResult {
  const args = ["test", "./...", "-v", "-count=1"];
  if (filter) args.push("-run", filter);

  const res = spawnSync("go", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = ((res.stdout ?? "") + (res.stderr ?? "")).slice(0, 32_000);

  return _parseGo(raw, fw, start);
}

function _parseGo(raw: string, fw: TestFramework, start: number): TestResult {
  let passed = 0, failed = 0, skipped = 0;
  const failures: TestFailure[] = [];

  for (const line of raw.split("\n")) {
    if (/^--- PASS:/.test(line))  passed++;
    if (/^--- SKIP:/.test(line))  skipped++;
    if (/^--- FAIL:/.test(line)) {
      failed++;
      const m = line.match(/^--- FAIL: (\S+)/);
      failures.push({ test: m?.[1] ?? line, message: "" });
    }
  }

  // Capture failure output: lines between "--- FAIL:" and the next "--- " or "FAIL\t"
  // Simple heuristic: include "FAIL" output blocks
  const failBlocks = raw.match(/--- FAIL:[\s\S]+?(?=--- (?:PASS|FAIL|SKIP)|^FAIL\t|\z)/gm) ?? [];
  for (let i = 0; i < failures.length && i < failBlocks.length; i++) {
    const f = failures[i];
    if (f) f.message = (failBlocks[i] ?? "").slice(0, 2000);
  }

  return { ok: failed === 0, framework: fw, passed, failed, skipped, failures, rawOutput: raw, durationMs: Date.now() - start };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _failedRun(fw: TestFramework, raw: string, start: number): TestResult {
  // The structured JSON report was unreadable. Salvage pass/fail counts from the
  // human reporter summary (e.g. vitest's "Tests  2 failed | 6 passed (8)") so the
  // agent still gets a usable signal instead of a dead-end "could not parse".
  const summary = raw.match(/Tests\s+(?:(\d+)\s+failed[^\n]*?)?\b(\d+)\s+passed/i);
  if (summary) {
    const failed = Number(summary[1] ?? 0);
    const passed = Number(summary[2] ?? 0);
    const skipped = Number(raw.match(/(\d+)\s+skipped/i)?.[1] ?? 0);
    return {
      ok: failed === 0, framework: fw, passed, failed, skipped,
      failures: failed > 0 ? [{ test: "(summary)", message: "Structured output was unreadable; see rawOutput for failing tests." }] : [],
      rawOutput: raw.slice(0, 32_000),
      durationMs: Date.now() - start,
    };
  }
  return {
    ok: false, framework: fw, passed: 0, failed: 0, skipped: 0,
    failures: [{ test: "(runner)", message: "Could not parse structured test output; see rawOutput for the full run." }],
    rawOutput: raw.slice(0, 32_000),
    durationMs: Date.now() - start,
  };
}

function _unknownFramework(root: string, start: number): TestResult {
  return {
    ok: false, framework: "unknown", passed: 0, failed: 0, skipped: 0,
    failures: [{ test: "(detection)", message: `No known test framework detected in ${root}. Add jest.config.*, vitest.config.*, pytest.ini, or go.mod.` }],
    rawOutput: "",
    durationMs: Date.now() - start,
  };
}
