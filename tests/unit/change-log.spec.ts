import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeLog, requestTitle } from "../../src/graph/change-log.js";

const dirs: string[] = [];
function logFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-changes-"));
  dirs.push(dir);
  return path.join(dir, "map", "changes.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ChangeLog", () => {
  it("records what a request changed, newest first, and survives a reload", () => {
    const file = logFile();
    const log = new ChangeLog(file);
    log.record({ sessionId: "s1", request: "Fix the billing rounding\nmore detail", files: [{ path: "services/billing/app.py", additions: 4, deletions: 1 }], at: 1 });
    log.record({ sessionId: "s1", request: "Add a retry", files: [{ path: "services/billing/app.py", additions: 2, deletions: 0 }], at: 2 });

    const reloaded = new ChangeLog(file);
    const rows = reloaded.changesTouching((id) => id.startsWith("services/billing/"), 10);
    expect(rows.map((row) => row.request)).toEqual(["Add a retry", "Fix the billing rounding"]);
    expect(rows[1]).toMatchObject({ additions: 4, deletions: 1 });
  });

  it("folds repeated edits from one request into one record", () => {
    const log = new ChangeLog(logFile());
    log.record({ sessionId: "s1", request: "Refactor", files: [{ path: "a.ts", additions: 1, deletions: 1 }], at: 1 });
    log.record({ sessionId: "s1", request: "Refactor", files: [{ path: "a.ts", additions: 3, deletions: 2 }], at: 2 });

    expect(log.changesTouching(() => true, 10)).toEqual([
      expect.objectContaining({ path: "a.ts", additions: 4, deletions: 3, at: 2 }),
    ]);
  });

  it("keeps a bounded history per file", () => {
    const log = new ChangeLog(logFile());
    for (let i = 0; i < 30; i += 1) {
      log.record({ sessionId: `s${i}`, request: `change ${i}`, files: [{ path: "a.ts", additions: 1, deletions: 0 }], at: i });
    }
    const rows = log.changesTouching(() => true, 100);
    expect(rows).toHaveLength(20);
    expect(rows[0]!.request).toBe("change 29");
  });

  it("skips files with no line changes and maps paths to map ids", () => {
    const log = new ChangeLog(logFile(), (value) => `root/${value}`);
    log.record({ sessionId: "s1", request: "x", files: [{ path: "a.ts", additions: 0, deletions: 0 }, { path: "b.ts", additions: 1, deletions: 0 }] });
    expect(log.changesTouching(() => true, 10).map((row) => row.path)).toEqual(["root/b.ts"]);
  });

  it("titles a request by its first non-empty line", () => {
    expect(requestTitle("\n\n  Fix it  \nthen more")).toBe("Fix it");
    expect(requestTitle("x".repeat(200))).toHaveLength(120);
  });
});
