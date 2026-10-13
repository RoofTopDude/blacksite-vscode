import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitRun } from "../../src/plans/step-snapshots.js";
import {
  copyDirtyFiles,
  copyLocation,
  createIsolatedCopy,
  listRunCopies,
  probeIsolation,
  removeRunCopy,
  runBranchName,
  seedIsolatedCopy,
  takeRunHandoff,
  writeRunHandoff,
  type IsolatedRunHandoff,
} from "../../src/plans/run-isolation.js";

function gitAvailable(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const suite = gitAvailable() ? describe : describe.skip;
const dirs: string[] = [];
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = defaultGitRun(env);

function temp(label: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `iso-${label}-`)));
  dirs.push(dir);
  return dir;
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function run(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
}

function repo(): string {
  const root = temp("repo");
  run(root, "init", "-q", "-b", "main");
  // The machine's own autocrlf would rewrite line endings in the copy's checkout.
  run(root, "config", "core.autocrlf", "false");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, ".gitignore", ".blacksite/\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "first");
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) {
    try { execFileSync("git", ["worktree", "prune"], { cwd: dir, stdio: "ignore" }); } catch { /* not a repo */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("naming", () => {
  it("makes a readable branch and a short folder outside the workspace", () => {
    expect(runBranchName("Ship the parser: phase 2!", "a1b2")).toBe("blacksite/run-ship-the-parser-phase-2-a1b2");
    expect(runBranchName("!!!", "a1b2")).toBe("blacksite/run-plan-a1b2");
    expect(copyLocation("/home/u", "/work/My Project", "a1b2")).toBe(path.join("/home/u", ".blacksite", "worktrees", "my-project-a1b2"));
  });
});

// Each test spawns a dozen git processes, which is slow on Windows under a parallel coverage run.
suite("isolated copies", { timeout: 30_000 }, () => {
  it("reports why a folder outside git cannot be copied", async () => {
    const plain = temp("plain");
    const probe = await probeIsolation(plain, git);
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/not in a git repository/);
  });

  it("probes, creates a worktree on a run branch, and leaves the original untouched", async () => {
    const root = repo();
    write(root, "src/a.ts", "export const a = 2; // uncommitted\n");
    write(root, "notes.txt", "untracked\n");
    const probe = await probeIsolation(root, git);
    expect(probe).toMatchObject({ available: true, branch: "main", dirtyFiles: 2, subpath: "" });

    const home = temp("home");
    const made = await createIsolatedCopy({ probe, planTitle: "Ship it", home, suffix: "c0de", git });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.copy.branch).toBe("blacksite/run-ship-it-c0de");
    expect(made.copy.baseBranch).toBe("main");
    // The copy starts from the last commit; the uncommitted change stays where it was.
    expect(fs.readFileSync(path.join(made.copy.copyRoot, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(fs.existsSync(path.join(made.copy.copyRoot, "notes.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("uncommitted");
    expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");

    const copies = await listRunCopies(root, git);
    expect(copies.map((copy) => copy.branch)).toEqual(["blacksite/run-ship-it-c0de"]);
    expect(await copyDirtyFiles(made.copy.worktreePath, git)).toBe(0);

    // Removing keeps the branch: its commits may be the thing worth keeping.
    expect(await removeRunCopy(root, made.copy.worktreePath, git, false)).toEqual({ ok: true });
    expect(fs.existsSync(made.copy.worktreePath)).toBe(false);
    expect(run(root, "branch", "--list", "blacksite/run-ship-it-c0de").trim()).toContain("blacksite/run-ship-it-c0de");
  });

  it("says when nested repositories would be left out of the copy", async () => {
    const root = repo();
    fs.mkdirSync(path.join(root, "services", "api", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "dep", ".git"), { recursive: true });
    const probe = await probeIsolation(root, git);
    expect(probe.notes.join(" ")).toContain("1 nested repository (services/api) is not part of the copy");
  });

  it("refuses to remove a folder that is not one of its copies", async () => {
    const root = repo();
    const outcome = await removeRunCopy(root, temp("other"), git, true);
    expect(outcome.ok).toBe(false);
  });

  it("opens the same subfolder the workspace was", async () => {
    const root = repo();
    write(root, "packages/app/index.ts", "x\n");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "app");
    const probe = await probeIsolation(path.join(root, "packages", "app"), git);
    expect(probe.subpath).toBe(path.join("packages", "app"));
    const made = await createIsolatedCopy({ probe, planTitle: "x", home: temp("home"), suffix: "0001", git });
    expect(made.ok && made.copy.copyRoot.endsWith(path.join("packages", "app"))).toBe(true);
  });
});

describe("seeding and handoff", () => {
  it("copies the plan and notes without overwriting what is already there", () => {
    const source = temp("src");
    const copy = temp("copy");
    write(source, ".blacksite/planning.json", "{\"plans\":[]}");
    write(source, ".blacksite/plans/plan1/doc.md", "# doc");
    write(source, ".blacksite/memory.md", "notes");
    write(copy, ".blacksite/memory.md", "tracked copy");
    const copied = seedIsolatedCopy(source, copy);
    expect(copied).toContain(path.join(".blacksite", "planning.json"));
    expect(copied).toContain(path.join(".blacksite", "plans"));
    expect(fs.readFileSync(path.join(copy, ".blacksite/memory.md"), "utf8")).toBe("tracked copy");
    expect(fs.existsSync(path.join(copy, ".blacksite/plans/plan1/doc.md"))).toBe(true);
  });

  it("hands the run over once, and never from a stale or malformed file", () => {
    const copy = temp("copy");
    const handoff: IsolatedRunHandoff = {
      schema: 1, planId: "plan1", charter: { maxUsd: 5 }, createdAt: 1_000_000, branch: "blacksite/run-x-0001",
      base: { root: "/w", branch: "main", head: "abc1234" }, worktreePath: copy,
    };
    writeRunHandoff(copy, handoff);
    expect(takeRunHandoff(copy, 1_000_000 + 60_000)).toEqual(handoff);
    // Read once: a reload of the window does not start the run again.
    expect(takeRunHandoff(copy, 1_000_000 + 60_000)).toBeUndefined();

    writeRunHandoff(copy, handoff);
    expect(takeRunHandoff(copy, 1_000_000 + 2 * 60 * 60_000)).toBeUndefined();
    expect(fs.existsSync(path.join(copy, ".blacksite", "run-handoff.json"))).toBe(false);

    write(copy, ".blacksite/run-handoff.json", "{not json");
    expect(takeRunHandoff(copy, 1_000_000)).toBeUndefined();
  });
});
