// Independent verifier for delegation-fanout: hidden tests the agent never saw, run against the
// workspace it left behind, plus each package's own tests. Prints {"EV-1":"pass"|"fail",...}.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? ".");
const href = (relative) => JSON.stringify(pathToFileURL(path.join(workspace, relative)).href);

const checks = {
  "EV-1": {
    pkg: "packages/text",
    imports: `import { slugify } from ${href("packages/text/src/slug.js")};`,
    body: `
      assert.equal(slugify("  Hello, World!  "), "hello-world");
      assert.equal(slugify("Already-slugged"), "already-slugged");
      assert.equal(slugify("--Many   spaces--here--"), "many-spaces-here");
      assert.equal(slugify("a__b"), "a-b");`,
  },
  "EV-2": {
    pkg: "packages/math",
    imports: `import { clamp } from ${href("packages/math/src/clamp.js")};`,
    body: `
      assert.equal(clamp(5, 0, 3), 3);
      assert.equal(clamp(-2, 0, 3), 0);
      assert.equal(clamp(2, 0, 3), 2);
      assert.throws(() => clamp(1, 3, 0), RangeError);`,
  },
  "EV-3": {
    pkg: "packages/list",
    imports: `import { chunk } from ${href("packages/list/src/chunk.js")};`,
    body: `
      assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
      assert.deepEqual(chunk([], 3), []);
      assert.throws(() => chunk([1], 0), RangeError);`,
  },
};

const dir = mkdtempSync(path.join(tmpdir(), "verify-fanout-"));
const verdicts = {};
try {
  for (const [subject, check] of Object.entries(checks)) {
    const file = path.join(dir, `${subject}.test.mjs`);
    writeFileSync(file, `import assert from "node:assert/strict";\nimport { test } from "node:test";\n${check.imports}\ntest(${JSON.stringify(subject)}, () => {${check.body}\n});\n`);
    const hidden = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", timeout: 60_000 });
    const own = spawnSync(process.execPath, ["--test"], { cwd: path.join(workspace, check.pkg), encoding: "utf8", timeout: 120_000 });
    verdicts[subject] = hidden.status === 0 && own.status === 0 ? "pass" : "fail";
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(verdicts)}\n`);
