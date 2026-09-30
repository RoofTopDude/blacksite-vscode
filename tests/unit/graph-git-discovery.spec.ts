import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  absoluteFromRepo,
  gitToplevel,
  groupRootsByRepo,
  ignoredPaths,
  listRepoFiles,
  parseNulList,
  rootPathspec,
} from "../../src/graph/git-discovery.js";

describe("git discovery helpers", () => {
  it("splits NUL-terminated output and drops the trailing empty entry", () => {
    expect(parseNulList("a.ts\0dir/b.ts\0")).toEqual(["a.ts", "dir/b.ts"]);
    expect(parseNulList("")).toEqual([]);
  });

  it("computes a root's pathspec relative to its repository, case-insensitively", () => {
    expect(rootPathspec("C:/work/mono", "C:/work/mono")).toBe("");
    expect(rootPathspec("C:/work/mono", "c:/Work/mono/apps/web")).toBe("apps/web");
    expect(rootPathspec("/srv/repo", "/srv/other")).toBeNull();
  });

  it("groups two roots inside one monorepo so they cost one git process", () => {
    const toplevels = new Map<string, string | null>([
      ["/w/mono/apps/web", "/w/mono"],
      ["/w/mono/services/api", "/w/mono"],
      ["/w/solo", "/w/solo"],
      ["/w/scratch", null],
    ]);
    const { groups, ungrouped } = groupRootsByRepo([...toplevels.keys()], toplevels);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.toplevel === "/w/mono")?.roots).toEqual(["/w/mono/apps/web", "/w/mono/services/api"]);
    expect(ungrouped).toEqual(["/w/scratch"]);
  });

  it("joins ls-files entries onto the toplevel", () => {
    expect(absoluteFromRepo("/w/mono/", ["a.ts", "b/c.ts"])).toEqual(["/w/mono/a.ts", "/w/mono/b/c.ts"]);
  });
});

/* A real repository, so the flags passed to git (and the .gitignore semantics
   the map now depends on) are exercised end to end. */
describe("git ls-files discovery against a real repository", () => {
  let dir = "";
  let gitAvailable = true;

  beforeAll(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "bs-git-discovery-"))).replace(/\\/g, "/");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      /* Keep the fixture's own line endings; otherwise Windows prints a CRLF
         warning per file into the test output. */
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
    } catch {
      gitAvailable = false;
      return;
    }
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "generated"), { recursive: true });
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "generated/\n*.log\n");
    writeFileSync(join(dir, "src/app.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/untracked.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, "generated/client.ts"), "export const c = 3;\n");
    writeFileSync(join(dir, "debug.log"), "noise\n");
    writeFileSync(join(dir, "pkg/index.ts"), "export {};\n");
    execFileSync("git", ["add", "src/app.ts", ".gitignore", "pkg/index.ts"], { cwd: dir });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists tracked and untracked files but never ignored ones", async () => {
    if (!gitAvailable) return;
    const top = await gitToplevel(dir);
    expect(top?.toLowerCase()).toBe(dir.toLowerCase());
    const files = (await listRepoFiles({ toplevel: top!, roots: [dir] }))!.map((p) => p.slice(top!.length + 1)).sort();
    expect(files).toContain("src/app.ts");
    expect(files).toContain("src/untracked.ts");
    expect(files).not.toContain("generated/client.ts");
    expect(files).not.toContain("debug.log");
  });

  it("limits a nested root to its own subtree", async () => {
    if (!gitAvailable) return;
    const top = (await gitToplevel(dir))!;
    const files = (await listRepoFiles({ toplevel: top, roots: [`${dir}/pkg`] }))!.map((p) => p.slice(top.length + 1));
    expect(files).toEqual(["pkg/index.ts"]);
  });

  it("reports which new paths git ignores, for the watcher", async () => {
    if (!gitAvailable) return;
    const top = (await gitToplevel(dir))!;
    const ignored = await ignoredPaths(top, [`${dir}/generated/new.ts`, `${dir}/src/new.ts`]);
    expect(ignored.has(`${top}/generated/new.ts`.toLowerCase())).toBe(true);
    expect(ignored.has(`${top}/src/new.ts`.toLowerCase())).toBe(false);
  });
});
