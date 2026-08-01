#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(resolve(root, "security/policy.json"), "utf8"));
const severityOrder = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const thresholdName = policy.dependencies?.failAtOrAbove ?? "high";
const threshold = severityOrder[thresholdName];
if (threshold === undefined) throw new Error(`Unknown dependency severity threshold: ${thresholdName}`);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this scanner through npm run security:dependencies.");
const audit = spawnSync(process.execPath, [npmCli, "audit", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 25 * 1024 * 1024,
  windowsHide: true,
});
if (audit.error) throw audit.error;

let report;
try { report = JSON.parse(audit.stdout || "{}"); }
catch {
  const detail = (audit.stderr || audit.stdout || "npm audit returned no JSON").trim().slice(0, 500);
  throw new Error(`Unable to parse npm's advisory response: ${detail}`);
}
if (report.error) {
  const summary = typeof report.error === "string"
    ? report.error
    : String(report.error.summary ?? report.error.message ?? "npm registry audit failed");
  throw new Error(`Dependency advisory lookup failed: ${summary.slice(0, 500)}`);
}
if (!report.metadata?.vulnerabilities) {
  throw new Error("Dependency advisory lookup returned no vulnerability metadata; refusing a false green result.");
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
let failures = 0;
for (const vulnerability of vulnerabilities.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
  const severity = String(vulnerability.severity ?? "info").toLowerCase();
  const references = (Array.isArray(vulnerability.via) ? vulnerability.via : [])
    .filter((entry) => entry && typeof entry === "object" && typeof entry.url === "string")
    .map((entry) => entry.url);
  const message = `${vulnerability.name}: ${severity}${references.length ? ` — ${references.join(", ")}` : ""}`;
  if ((severityOrder[severity] ?? 0) >= threshold) {
    failures += 1;
    console.error(`::error title=Dependency vulnerability::${message}`);
  } else {
    console.warn(`::warning title=Dependency advisory::${message}`);
  }
}

const totals = report.metadata?.vulnerabilities ?? {};
console.log(
  `Dependency audit: ${totals.total ?? vulnerabilities.length} known issue(s) ` +
  `(${totals.critical ?? 0} critical, ${totals.high ?? 0} high, ${totals.moderate ?? 0} moderate, ${totals.low ?? 0} low).`,
);
if (failures > 0) process.exitCode = 1;
