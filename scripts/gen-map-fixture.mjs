#!/usr/bin/env node
/* Generate a synthetic, dense, two-root workspace for exercising the Codebase
   Map at scale (docs/map-scale-implementation-plan.md §8).

     node scripts/gen-map-fixture.mjs <outDir> [--files 25000]

   Produces <outDir>/front (a TS monorepo: packages @acme/shared and @acme/ui,
   apps/web, apps/admin) and <outDir>/services (a Python service, a Rust
   workspace with two crates, a Go module), each its own git repository with
   scripted commits so co-change has history to read, plus an ignored
   `generated/` tree that must never reach the map. Open both folders as a
   multi-root workspace (<outDir>/fixture.code-workspace) in an Extension
   Development Host. */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? "map-fixture");
const filesFlag = args.indexOf("--files");
const target = filesFlag >= 0 ? Number(args[filesFlag + 1]) : 25_000;

rmSync(outDir, { recursive: true, force: true });
let written = 0;
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  written += 1;
};
const git = (cwd, ...argv) => execFileSync("git", argv, { cwd, stdio: "ignore" });

/* ---- front: TS monorepo ------------------------------------------------ */
const front = join(outDir, "front");
write(join(front, "package.json"), JSON.stringify({ name: "front", private: true, workspaces: ["packages/*", "apps/*"] }, null, 2));
write(join(front, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - apps/*\n");
write(join(front, ".gitignore"), "generated/\nnode_modules/\n");
write(join(front, "packages/shared/package.json"), JSON.stringify({ name: "@acme/shared", main: "dist/index.js", types: "dist/index.d.ts", exports: { ".": "./dist/index.js", "./format/*": "./dist/format/*.js" } }, null, 2));
write(join(front, "packages/ui/package.json"), JSON.stringify({ name: "@acme/ui", main: "dist/index.js", dependencies: { "@acme/shared": "workspace:*" } }, null, 2));
for (const app of ["web", "admin"]) {
  write(join(front, `apps/${app}/package.json`), JSON.stringify({ name: `@acme/${app}`, dependencies: { "@acme/shared": "workspace:*", "@acme/ui": "workspace:*", ...(app === "admin" ? { "@acme/unused": "workspace:*" } : {}) } }, null, 2));
}
write(join(front, "packages/unused/package.json"), JSON.stringify({ name: "@acme/unused", main: "src/index.ts" }, null, 2));
write(join(front, "packages/unused/src/index.ts"), "export const unused = true;\n");

const perApp = Math.floor(target * 0.28);
const shared = Math.floor(target * 0.08);
const ui = Math.floor(target * 0.08);
const sharedExports = [];
for (let i = 0; i < shared; i += 1) {
  const area = `area${i % 24}`;
  write(join(front, `packages/shared/src/${area}/mod${i}.ts`), `export const shared${i} = ${i};\n`);
  if (i < 200) sharedExports.push(`export * from "./${area}/mod${i}";`);
}
write(join(front, "packages/shared/src/index.ts"), `${sharedExports.join("\n")}\n`);
write(join(front, "packages/shared/src/format/date.ts"), "export const formatDate = (d: Date) => d.toISOString();\n");
for (let i = 0; i < ui; i += 1) {
  write(join(front, `packages/ui/src/widgets${i % 30}/Widget${i}.tsx`), `import { shared${i % shared} } from "@acme/shared";\nexport const Widget${i} = () => shared${i % shared};\n`);
}
write(join(front, "packages/ui/src/index.ts"), Array.from({ length: Math.min(ui, 200) }, (_, i) => `export * from "./widgets${i % 30}/Widget${i}";`).join("\n") + "\n");
for (const app of ["web", "admin"]) {
  for (let i = 0; i < perApp; i += 1) {
    const feature = `feature${i % 60}`;
    const imports = [
      `import { Widget${i % ui} } from "@acme/ui";`,
      `import { formatDate } from "@acme/shared/format/date";`,
      i > 0 ? `import { page${i - 1} } from "../${`feature${(i - 1) % 60}`}/page${i - 1}";` : "",
    ].filter(Boolean).join("\n");
    write(join(front, `apps/${app}/src/${feature}/page${i}.tsx`), `${imports}\nexport const page${i} = () => [Widget${i % ui}, formatDate];\n`);
  }
}
for (let i = 0; i < 3000; i += 1) write(join(front, `generated/client${i}.ts`), `export const generated${i} = ${i};\n`);

/* ---- services: Python, Rust, Go ---------------------------------------- */
const services = join(outDir, "services");
write(join(services, ".gitignore"), "generated/\ntarget/\n");
const py = Math.floor(target * 0.1);
write(join(services, "billing/pyproject.toml"), "[project]\nname = \"billing\"\n[tool.setuptools.packages.find]\nwhere = [\"src\"]\n");
for (let i = 0; i < py; i += 1) {
  write(join(services, `billing/src/billing/mod${i % 40}/impl${i}.py`), `from billing.mod${(i + 1) % 40} import helper\n\ndef impl${i}():\n    return helper()\n`);
}
for (let m = 0; m < 40; m += 1) write(join(services, `billing/src/billing/mod${m}/__init__.py`), "def helper():\n    return 1\n");
write(join(services, "billing/src/billing/api.py"), [
  "from flask import Flask",
  "app = Flask(__name__)",
  "",
  "@app.route('/api/orders', methods=['POST'])",
  "def create_order():",
  "    return {}",
  "",
].join("\n"));
write(join(services, "Cargo.toml"), "[workspace]\nmembers = [\"crates/core\", \"crates/cli\"]\n");
write(join(services, "crates/core/Cargo.toml"), "[package]\nname = \"acme-core\"\nversion = \"0.1.0\"\n");
write(join(services, "crates/cli/Cargo.toml"), "[package]\nname = \"acme-cli\"\nversion = \"0.1.0\"\n[dependencies]\nacme-core = { path = \"../core\" }\n");
const rs = Math.floor(target * 0.04);
const coreMods = [];
for (let i = 0; i < rs; i += 1) {
  write(join(services, `crates/core/src/m${i}.rs`), `pub fn m${i}() -> u32 { ${i} }\n`);
  coreMods.push(`pub mod m${i};`);
}
write(join(services, "crates/core/src/lib.rs"), `${coreMods.join("\n")}\n`);
write(join(services, "crates/cli/src/main.rs"), `use acme_core::m0;\nfn main() { m0::m0(); }\n`);
write(join(services, "gateway/go.mod"), "module example.com/gateway\n\ngo 1.22\n");
for (let i = 0; i < Math.floor(target * 0.02); i += 1) {
  write(join(services, `gateway/internal/h${i % 20}/h${i}.go`), `package h${i % 20}\n\nfunc H${i}() int { return ${i} }\n`);
}
write(join(front, "apps/web/src/api/orders.ts"), "export const createOrder = () => fetch('/api/orders', { method: 'POST' });\n");
for (let i = 0; i < 1500; i += 1) write(join(services, `generated/stub${i}.py`), `STUB = ${i}\n`);

/* ---- history: co-change across the two roots is impossible (separate
   repos), so couple files *within* each repo, including one pair that no
   import explains. */
for (const repo of [front, services]) {
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
}
const touch = (repo, rel, n) => write(join(repo, rel), `// revision ${n}\n${"x".repeat(n)}\n`);
for (let n = 0; n < 6; n += 1) {
  touch(front, "apps/web/src/api/orders.ts", n);
  touch(front, "packages/ui/src/widgets0/Widget0.tsx", n);
  git(front, "commit", "-q", "-am", `orders + widget ${n}`);
  touch(services, "billing/src/billing/api.py", n);
  touch(services, "crates/core/src/m1.rs", n);
  git(services, "commit", "-q", "-am", `api + core ${n}`);
}

write(join(outDir, "fixture.code-workspace"), JSON.stringify({ folders: [{ path: "front" }, { path: "services" }] }, null, 2));
console.log(`Wrote ${written.toLocaleString()} files (4,500 of them git-ignored) to ${outDir}`);
