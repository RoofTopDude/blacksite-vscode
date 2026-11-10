#!/usr/bin/env node
// Execution-log failure-rate analyzer.
//
// Ingests one or more Blacksite execution `.jsonl` logs and reports the tool-call
// failure rate — the metric behind the reliability goal (1000-iteration runs at
// <5% tool failure). Use it to measure soak runs and catch regressions:
//
//   node scripts/analyze-execution-log.mjs path/to/execution.jsonl [more.jsonl ...]
//   node scripts/analyze-execution-log.mjs --threshold 5 run1.jsonl run2.jsonl
//
// Exits non-zero when the overall failure rate exceeds the threshold (default 5%),
// so it can gate CI / a soak harness.

import fs from "node:fs";

function parseArgs(argv) {
  const files = [];
  let threshold = 5;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold" || a === "-t") threshold = Number(argv[++i]);
    else files.push(a);
  }
  return { files, threshold };
}

/* Friction: effort spent satisfying the harness rather than doing the task. Forced closing
   continuations, gates that gave up, bookkeeping calls, calls refused before they ran, and runs
   the user cut short. Informational — it never affects the exit code. Compare a set of sessions
   before and after a harness change to see whether the agent spends less of its time on these. */
const BOOKKEEPING_TOOLS = new Set([
  "map_note_add", "map_note_update", "map_note_list", "map_note_remove",
  "plan_update", "todo_create", "todo_update", "todo_list",
]);
const CONTINUATIONS = [
  ["map note", /^Edited without a Codebase Map note/],
  ["verification", /^Edit verification \w+ for/],
  ["empty reply", /^Post-tool response had no visible text/],
];
const GAVE_UP = [
  ["map note", /^Finishing without a Codebase Map note/],
  ["verification", /^Finishing with unverified edits/],
];
const REFUSED = /^(Invalid arguments for|Argument "|`[^`]+` is (still )?not installed|The "[^"]+" tool is disabled)/;

function newFriction() {
  return {
    turns: 0, iterations: 0,
    continuations: new Map(), gaveUp: new Map(),
    bookkeeping: 0, unsettledDiagnostics: 0, refused: new Map(), cancelled: 0,
  };
}

function analyze(files) {
  const perTool = new Map(); // name -> { total, fail, msgs: Map }
  const errors = [];
  const diagnostics = new Map();
  const stopReasons = new Map();
  const friction = newFriction();
  // Context reports are cumulative per session, so the last one a session wrote is its summary.
  const contextBySession = new Map();
  let toolTotal = 0;
  let toolFail = 0;

  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (err) { console.error(`! cannot read ${file}: ${err.message}`); continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.kind === "turn_start") friction.turns++;
      const d = o.data ?? {};
      switch (o.eventType) {
        case "iteration_start":
          friction.iterations++;
          break;
        case "tool_call_result": {
          const name = d.toolName ?? "?";
          const entry = perTool.get(name) ?? { total: 0, fail: 0, msgs: new Map() };
          entry.total++; toolTotal++;
          const summary = String(d.summary ?? d.result?.message ?? "?");
          if (d.ok === false) {
            entry.fail++; toolFail++;
            bump(entry.msgs, summary.slice(0, 80).replace(/\d+/g, "#"));
            if (REFUSED.test(summary)) bump(friction.refused, summary.slice(0, 60).replace(/\d+/g, "#"));
          }
          if (BOOKKEEPING_TOOLS.has(name)) friction.bookkeeping++;
          if (name === "code_diagnostics" && /timed_out|not caught up/i.test(summary)) friction.unsettledDiagnostics++;
          perTool.set(name, entry);
          break;
        }
        case "error":
          errors.push(String(d.message ?? "?").slice(0, 120));
          break;
        case "execution_diagnostic": {
          const message = String(d.message ?? "?");
          bump(diagnostics, message.slice(0, 70).replace(/\d+/g, "#"));
          for (const [label, pattern] of CONTINUATIONS) if (pattern.test(message)) bump(friction.continuations, label);
          for (const [label, pattern] of GAVE_UP) if (pattern.test(message)) bump(friction.gaveUp, label);
          break;
        }
        case "context_report":
          if (d.report) contextBySession.set(`${o.sessionId ?? "?"}${o.lane ? `:${o.lane}` : ""}`, d.report);
          break;
        case "turn_complete":
          bump(stopReasons, d.stopReason ?? "?");
          if (d.stopReason === "cancelled") friction.cancelled++;
          break;
        default:
          break;
      }
    }
  }
  return { perTool, errors, diagnostics, stopReasons, toolTotal, toolFail, friction, contextBySession };
}

/* Context economy (blacksite.context.report). Per session: what the requests carried and what was
   paid for. Informational, never affects the exit code. See docs/context-economy-implementation-plan.md. */
function printContext(sessions) {
  if (sessions.size === 0) return;
  const k = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n ?? 0)));
  const pct = (n) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
  console.log(`\nContext (${sessions.size} session${sessions.size === 1 ? "" : "s"} with reports):`);
  const totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, superseded: 0, unreferenced: 0, recovery: 0 };
  for (const [id, r] of sessions) {
    const s = r.session ?? {};
    totals.requests += s.requests ?? 0;
    totals.input += s.input ?? 0;
    totals.cacheRead += s.cacheRead ?? 0;
    totals.cacheWrite += s.cacheWrite ?? 0;
    totals.output += s.output ?? 0;
    totals.superseded += r.toolResults?.superseded?.tokens ?? 0;
    totals.unreferenced += r.toolResults?.unreferenced?.tokens ?? 0;
    totals.recovery += r.recoveryCalls ?? 0;
    const perRequest = s.requests ? (s.input + s.cacheRead + s.cacheWrite) / s.requests : 0;
    console.log(`  ${id.slice(-14)}  requests=${s.requests}  in=${k(s.input)}  cacheR=${k(s.cacheRead)}  cacheW=${k(s.cacheWrite)}  uncached=${pct(s.uncachedShare)}  peak=${k(s.peakContextTokens)}  per-request=${k(perRequest)}`);
    const latest = r.latest?.byClassTokens;
    if (latest) {
      const parts = Object.entries(latest).filter(([, v]) => v > 0).map(([cls, v]) => `${cls}=${k(v)}`);
      console.log(`      latest request by class: ${parts.join("  ")}`);
    }
    const carried = Object.entries(r.byClass ?? {}).filter(([, v]) => v.carriedTokens > 0).sort((a, b) => b[1].carriedTokens - a[1].carriedTokens);
    if (carried.length) console.log(`      carried over the session: ${carried.map(([cls, v]) => `${cls}=${k(v.carriedTokens)}`).join("  ")}`);
    for (const item of (r.costliest ?? []).slice(0, 5)) {
      console.log(`      ${k(item.carriedTokens).padStart(6)}  ${item.class}${item.label ? ` (${item.label})` : ""}  ${k(item.tokens)} × ${item.carried} requests`);
    }
    if (r.toolResults) {
      const t = r.toolResults;
      console.log(`      tool results: ${t.count} (${k(t.tokens)})  superseded: ${t.superseded.count} (${k(t.superseded.tokens)})  never referred to again: ${t.unreferenced.count} (${k(t.unreferenced.tokens)})`);
      if (t.repeatedReads?.length) console.log(`      read more than once: ${t.repeatedReads.slice(0, 5).map((x) => `${x.path} ×${x.reads}`).join(", ")}`);
    }
    if (r.calibrationRatio != null) console.log(`      estimator calibration (reported ÷ estimated): ${r.calibrationRatio.toFixed(2)}`);
  }
  const denom = totals.input + totals.cacheRead + totals.cacheWrite;
  console.log(`  All: requests=${totals.requests}  in=${k(totals.input)}  cacheR=${k(totals.cacheRead)}  cacheW=${k(totals.cacheWrite)}  out=${k(totals.output)}  uncached=${denom ? pct(totals.input / denom) : "n/a"}  superseded=${k(totals.superseded)}  unreferenced=${k(totals.unreferenced)}  recovery calls=${totals.recovery}`);
}

function printFriction(f, toolTotal) {
  const pct = (n, of) => (of ? `${((100 * n) / of).toFixed(1)}%` : "n/a");
  const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0);
  const forced = sum(f.continuations);
  console.log("\nFriction (effort spent on the harness rather than the task):");
  console.log(`  Turns: ${f.turns}   Iterations: ${f.iterations}`);
  console.log(`  Forced closing continuations: ${forced}${f.turns ? ` (${(forced / f.turns).toFixed(2)} per turn)` : ""}`);
  [...f.continuations.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`      ${String(c).padStart(4)}  ${k}`));
  console.log(`  Gates that gave up after their reminders: ${sum(f.gaveUp)}`);
  [...f.gaveUp.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`      ${String(c).padStart(4)}  ${k}`));
  console.log(`  Bookkeeping calls (map notes, plan/todo updates): ${f.bookkeeping} (${pct(f.bookkeeping, toolTotal)} of tool calls)`);
  console.log(`  Diagnostics calls that did not settle: ${f.unsettledDiagnostics}`);
  console.log(`  Calls refused before they ran: ${sum(f.refused)}`);
  [...f.refused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, c]) => console.log(`      ${String(c).padStart(4)}  ${k}`));
  console.log(`  Runs cancelled by the user: ${f.cancelled}${f.turns ? ` (${pct(f.cancelled, f.turns)} of turns)` : ""}`);
}

function main() {
  const { files, threshold } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error("usage: analyze-execution-log.mjs [--threshold N] <execution.jsonl> [...]");
    process.exit(2);
  }
  const r = analyze(files);
  const rate = r.toolTotal ? (100 * r.toolFail) / r.toolTotal : 0;

  console.log(`\nTool calls: ${r.toolTotal}   Failures: ${r.toolFail}   Rate: ${rate.toFixed(2)}%   (goal <${threshold}%)`);

  console.log("\nPer-tool failures (fail/total):");
  [...r.perTool.entries()]
    .filter(([, e]) => e.fail > 0)
    .sort((a, b) => b[1].fail - a[1].fail)
    .forEach(([name, e]) => {
      console.log(`  ${String(e.fail).padStart(3)}/${String(e.total).padStart(3)}  ${name}`);
      [...e.msgs.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, c]) => console.log(`        ${String(c).padStart(3)}  ${m}`));
    });

  if (r.stopReasons.size) {
    console.log("\nTurn stop reasons:");
    [...r.stopReasons.entries()].sort((a, b) => b[1] - a[1]).forEach(([s, c]) => console.log(`  ${String(c).padStart(3)}  ${s}`));
  }
  if (r.errors.length) {
    console.log(`\nProvider/terminal errors (${r.errors.length}):`);
    const counts = new Map();
    r.errors.forEach((e) => counts.set(e.replace(/\d+/g, "#"), (counts.get(e.replace(/\d+/g, "#")) ?? 0) + 1));
    [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([e, c]) => console.log(`  ${String(c).padStart(3)}  ${e}`));
  }

  printFriction(r.friction, r.toolTotal);
  printContext(r.contextBySession);

  const pass = rate <= threshold;
  console.log(`\n${pass ? "PASS" : "FAIL"}: ${rate.toFixed(2)}% ${pass ? "<=" : ">"} ${threshold}% threshold\n`);
  process.exit(pass ? 0 : 1);
}

main();
