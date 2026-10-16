#!/usr/bin/env node
// Builds a synthetic evaluation workspace: several small nested packages with their own
// `node --test` suites and no dependencies to install, so a live evaluation measures the agent and
// not npm. Deterministic: the same layout every time. Nothing here is copied from a real project.
//
//   node scripts/gen-eval-fixture.mjs <scenario> <empty target dir>
//
// Also seeds .blacksite/tickets.json or .blacksite/planning.json from the scenario's fixture file.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repo, "tests", "eval", "fixtures");

const PACKAGE = (name) => `${JSON.stringify({ name, version: "0.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`;

/** The shared layout both live scenarios start from: two levels of nesting, four codebases. */
const NESTED_PACKAGES = {
  "README.md": "# Eval workspace\n\nSynthetic packages for Blacksite orchestration evaluations. Each package runs its tests with `node --test`.\n",
  "package.json": `${JSON.stringify({ name: "eval-workspace", private: true, workspaces: ["packages/*", "services/*"] }, null, 2)}\n`,
  "packages/text/package.json": PACKAGE("@eval/text"),
  "packages/text/src/index.js": "export function capitalize(text) {\n  return text ? text[0].toUpperCase() + text.slice(1) : text;\n}\n",
  "packages/text/test/index.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { capitalize } from \"../src/index.js\";\n\ntest(\"capitalize\", () => {\n  assert.equal(capitalize(\"word\"), \"Word\");\n  assert.equal(capitalize(\"\"), \"\");\n});\n",
  "packages/math/package.json": PACKAGE("@eval/math"),
  "packages/math/src/index.js": "export function sum(values) {\n  return values.reduce((total, value) => total + value, 0);\n}\n",
  "packages/math/test/index.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { sum } from \"../src/index.js\";\n\ntest(\"sum\", () => {\n  assert.equal(sum([1, 2, 3]), 6);\n});\n",
  "packages/list/package.json": PACKAGE("@eval/list"),
  "packages/list/src/index.js": "export function last(items) {\n  return items[items.length - 1];\n}\n",
  "packages/list/test/index.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { last } from \"../src/index.js\";\n\ntest(\"last\", () => {\n  assert.equal(last([1, 2]), 2);\n});\n",
  "packages/money/package.json": PACKAGE("@eval/money"),
  "packages/money/src/money.js": "/** Whole currency units to cents. */\nexport function toCents(amount) {\n  return Math.round(amount * 100);\n}\n",
  "packages/money/test/money.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { toCents } from \"../src/money.js\";\n\ntest(\"toCents\", () => {\n  assert.equal(toCents(12), 1200);\n  assert.equal(toCents(0.1), 10);\n});\n",
  "services/billing/package.json": PACKAGE("@eval/billing"),
  "services/billing/src/invoice.js": "import { toCents } from \"../../../packages/money/src/money.js\";\n\nexport function invoiceTotal(lines) {\n  return lines.reduce((total, line) => total + toCents(line.amount) * line.quantity, 0);\n}\n",
  "services/billing/test/invoice.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { invoiceTotal } from \"../src/invoice.js\";\n\ntest(\"invoiceTotal\", () => {\n  assert.equal(invoiceTotal([{ amount: 2.5, quantity: 2 }, { amount: 1, quantity: 1 }]), 600);\n});\n",
  "services/checkout/package.json": PACKAGE("@eval/checkout"),
  "services/checkout/src/cart.js": "import { toCents } from \"../../../packages/money/src/money.js\";\n\nexport function cartTotalCents(items) {\n  return items.map((item) => toCents(item.price)).reduce((a, b) => a + b, 0);\n}\n",
  "services/checkout/test/cart.test.js": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { cartTotalCents } from \"../src/cart.js\";\n\ntest(\"cartTotalCents\", () => {\n  assert.equal(cartTotalCents([{ price: 1.25 }, { price: 3 }]), 425);\n});\n",
};

const LAYOUTS = { "nested-packages": NESTED_PACKAGES };

function seedTickets(scenario, dir) {
  const now = "2026-01-01T00:00:00.000Z";
  const tickets = scenario.tickets.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    status: "backlog",
    statusSource: "manual",
    priority: "normal",
    complexity: ticket.complexity ?? "small",
    labels: [],
    acceptanceCriteria: ticket.acceptanceCriteria ?? [],
    territory: ticket.territory ?? { files: [], areas: [] },
    references: [],
    runIds: [],
    blockedBy: [],
    blocks: [],
    relatedTo: [],
    children: [],
    assignee: "agent",
    origin: "user",
    events: [],
    createdAt: now,
    updatedAt: now,
  }));
  writeFileSync(path.join(dir, ".blacksite", "tickets.json"), `${JSON.stringify({ schemaVersion: 3, updatedAt: now, tickets }, null, 2)}\n`);
}

function seedPlan(scenario, dir) {
  const now = "2026-01-01T00:00:00.000Z";
  const plan = {
    id: scenario.plan.id,
    title: scenario.plan.title,
    status: "active",
    phases: scenario.plan.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      files: phase.files ?? [],
      acceptanceCriteria: phase.acceptanceCriteria ?? [],
      status: "pending",
      steps: phase.steps.map((step) => ({ id: step.id, title: step.title, status: "pending", notes: [], updatedAt: now })),
      blocks: [], docs: [], notes: [], linkedTodoIds: [], updatedAt: now,
    })),
    blocks: [], docs: [], agentCanArchive: false, executionApproved: false, notes: [], createdAt: now, updatedAt: now,
  };
  writeFileSync(path.join(dir, ".blacksite", "planning.json"), `${JSON.stringify({ schemaVersion: 3, updatedAt: now, plans: [plan], todoRuns: [] }, null, 2)}\n`);
}

export function listScenarios() {
  return readdirSync(fixturesDir).filter((name) => existsSync(path.join(fixturesDir, name, "scenario.json"))).sort();
}

export function readScenario(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name, "scenario.json"), "utf8"));
}

export function generateFixture(name, dir) {
  const scenario = readScenario(name);
  const layout = LAYOUTS[scenario.workspace];
  if (!layout) throw new Error(`Unknown workspace layout "${scenario.workspace}" in ${name}`);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
  for (const [relative, content] of Object.entries(layout)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  mkdirSync(path.join(dir, ".blacksite"), { recursive: true });
  if (scenario.subject === "loop") seedTickets(scenario, dir);
  else seedPlan(scenario, dir);
  return scenario;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, target] = process.argv.slice(2);
  if (!name || !target) {
    console.error(`usage: node scripts/gen-eval-fixture.mjs <scenario> <empty dir>\nscenarios: ${listScenarios().join(", ")}`);
    process.exit(2);
  }
  generateFixture(name, path.resolve(target));
  console.log(`Generated ${name} in ${path.resolve(target)}`);
}
