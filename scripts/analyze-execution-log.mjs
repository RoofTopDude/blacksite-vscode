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

function analyze(files) {
  const perTool = new Map(); // name -> { total, fail, msgs: Map }
  const errors = [];
  const diagnostics = new Map();
  const stopReasons = new Map();
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
      const d = o.data ?? {};
      switch (o.eventType) {
        case "tool_call_result": {
          const name = d.toolName ?? "?";
          const entry = perTool.get(name) ?? { total: 0, fail: 0, msgs: new Map() };
          entry.total++; toolTotal++;
          if (d.ok === false) {
            entry.fail++; toolFail++;
            const msg = String(d.summary ?? d.result?.message ?? "?").slice(0, 80).replace(/\d+/g, "#");
            bump(entry.msgs, msg);
          }
          perTool.set(name, entry);
          break;
        }
        case "error":
          errors.push(String(d.message ?? "?").slice(0, 120));
          break;
        case "execution_diagnostic":
          bump(diagnostics, String(d.message ?? "?").slice(0, 70).replace(/\d+/g, "#"));
          break;
        case "turn_complete":
          bump(stopReasons, d.stopReason ?? "?");
          break;
        default:
          break;
      }
    }
  }
  return { perTool, errors, diagnostics, stopReasons, toolTotal, toolFail };
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

  const pass = rate <= threshold;
  console.log(`\n${pass ? "PASS" : "FAIL"}: ${rate.toFixed(2)}% ${pass ? "<=" : ">"} ${threshold}% threshold\n`);
  process.exit(pass ? 0 : 1);
}

main();
