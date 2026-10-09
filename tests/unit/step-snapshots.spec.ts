import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StepSnapshotter, projectKey, type GitRun } from "../../src/plans/step-snapshots.js";

function gitAvailable(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const suite = gitAvailable() ? describe : describe.skip;
const dirs: string[] = [];

function temp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `snap-${label}-`));
  dirs.push(dir);
  return dir;
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
}

function sha(file: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

suite("StepSnapshotter", () => {
  it("captures, then puts back changed, deleted and created files — including ones a shell made", async () => {
    const project = temp("project");
    const store = temp("store");
    write(project, "src/a.ts", "export const a = 1;\n");
    write(project, "src/b.ts", "export const b = 2;\n");
    write(project, "README.md", "# hi\n");
    const snapshots = new StepSnapshotter({ storageDir: store });

    const before = await snapshots.capture([project]);
    const tree = before.projects[path.resolve(project)]!;
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);

    write(project, "src/a.ts", "export const a = 999;\n");
    fs.rmSync(path.join(project, "src/b.ts"));
    write(project, "generated/out.json", "{\"made\":\"by a shell command\"}\n");

    const plan = await snapshots.plan(project, tree);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.restore.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.remove).toEqual(["generated/out.json"]);

    const result = await snapshots.apply(plan);
    expect(result).toEqual({ ok: true });
    expect(read(project, "src/a.ts")).toBe("export const a = 1;\n");
    expect(read(project, "src/b.ts")).toBe("export const b = 2;\n");
    expect(fs.existsSync(path.join(project, "generated/out.json"))).toBe(false);
    // The folder that held only the removed file goes with it.
    expect(fs.existsSync(path.join(project, "generated"))).toBe(false);
    expect(read(project, "README.md")).toBe("# hi\n");
  });

  it("can undo a restore using the state it recorded first", async () => {
    const project = temp("undo");
    const store = temp("store");
    write(project, "a.txt", "one\n");
    const snapshots = new StepSnapshotter({ storageDir: store });
    const first = (await snapshots.capture([project])).projects[path.resolve(project)]!;
    write(project, "a.txt", "two\n");
    write(project, "b.txt", "extra\n");

    const plan = await snapshots.plan(project, first);
    if ("error" in plan) throw new Error(plan.error);
    await snapshots.apply(plan);
    expect(read(project, "a.txt")).toBe("one\n");

    const back = await snapshots.plan(project, plan.safetyTree);
    if ("error" in back) throw new Error(back.error);
    await snapshots.apply(back);
    expect(read(project, "a.txt")).toBe("two\n");
    expect(read(project, "b.txt")).toBe("extra\n");
  });

  it("never touches the user's own repository: index, refs, stash and status stay exactly as they were", async () => {
    const project = temp("repo");
    const store = temp("store");
    git(project, "init", "-q");
    write(project, "tracked.ts", "x\n");
    git(project, "add", "tracked.ts");
    git(project, "commit", "-q", "-m", "init");
    write(project, "staged.ts", "staged\n");
    git(project, "add", "staged.ts");
    write(project, "untracked.ts", "u\n");

    const indexBefore = sha(path.join(project, ".git", "index"));
    const statusBefore = git(project, "status", "--porcelain");
    const refsBefore = git(project, "for-each-ref");
    const headBefore = git(project, "rev-parse", "HEAD");

    const snapshots = new StepSnapshotter({ storageDir: store });
    const captured = await snapshots.capture([project]);
    const tree = captured.projects[path.resolve(project)]!;
    write(project, "tracked.ts", "changed\n");
    const plan = await snapshots.plan(project, tree);
    if ("error" in plan) throw new Error(plan.error);
    await snapshots.apply(plan);

    expect(read(project, "tracked.ts")).toBe("x\n");
    expect(sha(path.join(project, ".git", "index"))).toBe(indexBefore);
    expect(git(project, "status", "--porcelain")).toBe(statusBefore);
    expect(git(project, "for-each-ref")).toBe(refsBefore);
    expect(git(project, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(project, "stash", "list")).toBe("");
  });

  it("honours .gitignore and leaves out folders that are never worth keeping", async () => {
    const project = temp("ignore");
    const store = temp("store");
    write(project, ".gitignore", "dist/\n*.log\n");
    write(project, "src/a.ts", "a\n");
    write(project, "dist/bundle.js", "built\n");
    write(project, "debug.log", "noise\n");
    write(project, "node_modules/pkg/index.js", "dep\n");
    write(project, ".blacksite/plan-runs/x/run.json", "{}\n");

    const snapshots = new StepSnapshotter({ storageDir: store });
    const tree = (await snapshots.capture([project])).projects[path.resolve(project)]!;
    const listing = execFileSync("git", ["--git-dir", snapshots.gitDir(project), "ls-tree", "-r", "--name-only", tree], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(listing).toEqual([".gitignore", "src/a.ts"]);
  });

  it("restores an ignored build folder to nothing rather than deleting it", async () => {
    const project = temp("ignored-keep");
    const store = temp("store");
    write(project, ".gitignore", "dist/\n");
    write(project, "a.ts", "a\n");
    write(project, "dist/out.js", "built\n");
    const snapshots = new StepSnapshotter({ storageDir: store });
    const tree = (await snapshots.capture([project])).projects[path.resolve(project)]!;
    write(project, "a.ts", "b\n");
    const plan = await snapshots.plan(project, tree);
    if ("error" in plan) throw new Error(plan.error);
    await snapshots.apply(plan);
    expect(read(project, "a.ts")).toBe("a\n");
    expect(read(project, "dist/out.js")).toBe("built\n");
  });

  it("says when a repository inside the project is not captured", async () => {
    const project = temp("nested");
    const store = temp("store");
    write(project, "top.ts", "t\n");
    const inner = path.join(project, "vendor", "lib");
    fs.mkdirSync(inner, { recursive: true });
    git(inner, "init", "-q");
    write(inner, "x.ts", "x\n");
    git(inner, "add", "x.ts");
    git(inner, "commit", "-q", "-m", "x");

    const snapshots = new StepSnapshotter({ storageDir: store });
    const captured = await snapshots.capture([project]);
    expect(captured.projects[path.resolve(project)]).toBeDefined();
    expect(captured.skipped).toMatch(/1 nested repository is not captured/);
  });

  it("keeps projects apart and reports each file that differs between two states", async () => {
    const a = temp("a");
    const b = temp("b");
    const store = temp("store");
    write(a, "f.txt", "a1\n");
    write(b, "g.txt", "b1\n");
    const snapshots = new StepSnapshotter({ storageDir: store });
    const first = await snapshots.capture([a, b]);
    expect(Object.keys(first.projects)).toHaveLength(2);
    expect(snapshots.gitDir(a)).not.toBe(snapshots.gitDir(b));

    write(a, "f.txt", "a2\n");
    write(a, "new.txt", "n\n");
    const second = await snapshots.capture([a]);
    const changes = await snapshots.changedFiles(a, first.projects[path.resolve(a)]!, second.projects[path.resolve(a)]!);
    expect(changes.map((change) => `${change.status}:${change.path}`).sort()).toEqual(["A:new.txt", "M:f.txt"]);
    expect(await snapshots.fileAt(a, first.projects[path.resolve(a)]!, "f.txt")).toBe("a1\n");
    expect(await snapshots.fileAt(a, first.projects[path.resolve(a)]!, "new.txt")).toBeUndefined();
  });

  it("skips a folder that does not exist and says so", async () => {
    const store = temp("store");
    const snapshots = new StepSnapshotter({ storageDir: store });
    const captured = await snapshots.capture([path.join(store, "nope")]);
    expect(captured.projects).toEqual({});
    expect(captured.skipped).toMatch(/folder not found/);
  });

  it("gives up on a project that takes too long instead of hanging the run", async () => {
    const project = temp("slow");
    const store = temp("store");
    write(project, "a.txt", "a\n");
    const slow: GitRun = async (args) => {
      if (args.includes("add")) return { code: null, stdout: "", stderr: "", timedOut: true };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const snapshots = new StepSnapshotter({ storageDir: store, run: slow, captureTimeoutMs: 5 });
    const captured = await snapshots.capture([project]);
    expect(captured.projects).toEqual({});
    expect(captured.skipped).toMatch(/too large to capture/);
  });

  it("reports git being unavailable as a reason, not a crash", async () => {
    const project = temp("nogit");
    const store = temp("store");
    const missing: GitRun = async () => ({ code: null, stdout: "", stderr: "spawn git ENOENT", timedOut: false });
    const snapshots = new StepSnapshotter({ storageDir: store, run: missing });
    const captured = await snapshots.capture([project]);
    expect(captured.projects).toEqual({});
    expect(captured.skipped).toBeTruthy();
  });

  it("prunes private repositories nobody has used lately", async () => {
    const project = temp("old");
    const store = temp("store");
    write(project, "a.txt", "a\n");
    const snapshots = new StepSnapshotter({ storageDir: store });
    await snapshots.capture([project]);
    expect(snapshots.prune(30)).toBe(0);
    expect(snapshots.prune(30, Date.now() + 60 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(snapshots.gitDir(project))).toBe(false);
  });

  it("keys a project by its path", () => {
    expect(projectKey("/a/b")).toBe(projectKey("/a/b"));
    expect(projectKey("/a/b")).not.toBe(projectKey("/a/c"));
  });
});
