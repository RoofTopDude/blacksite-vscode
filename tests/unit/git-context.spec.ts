import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { handleGitOp } from "@blacksite/local-runtime";

let root: string;

function git(...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-git-context-"));
  git("init", "-b", "trunk");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Blacksite Test");
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  fs.mkdirSync(path.join(root, ".github"));
  fs.writeFileSync(path.join(root, ".github", "pull_request_template.md"), "## Verification\n", "utf8");
  git("add", "-A");
  git("commit", "-m", "initial");
  git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  git("checkout", "-b", "feature/context");
  fs.writeFileSync(path.join(root, "README.md"), "base\nfeature\n", "utf8");
  git("add", "README.md");
  git("commit", "-m", "feat: context");
  fs.writeFileSync(path.join(root, "working.txt"), "not staged\n", "utf8");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("git context workflow", () => {
  it("returns base-aware local and remote PR context in one bounded result", () => {
    const result = handleGitOp(root, { op: "context", base: "trunk" }, process.env) as {
      ok: boolean;
      data: any;
    };

    expect(result.ok).toBe(true);
    expect(result.data.status.branch).toBe("feature/context");
    expect(result.data.baseRef).toBe("trunk");
    expect(result.data.remote).toMatchObject({ provider: "github", owner: "acme", repo: "widgets" });
    expect(result.data.commits.map((commit: any) => commit.message)).toContain("feat: context");
    expect(result.data.committed.files.map((file: any) => file.path)).toContain("README.md");
    expect(result.data.status.untracked).toContain("working.txt");
    expect(result.data.pullRequestTemplate).toMatchObject({ path: ".github/pull_request_template.md" });
  });

  it("discovers the conventional pull-request template directory", () => {
    fs.rmSync(path.join(root, ".github", "pull_request_template.md"));
    fs.mkdirSync(path.join(root, ".github", "PULL_REQUEST_TEMPLATE"));
    fs.writeFileSync(path.join(root, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"), "## Feature checklist\n", "utf8");

    const result = handleGitOp(root, { op: "context", base: "trunk" }, process.env) as { data: any };

    expect(result.data.pullRequestTemplate).toMatchObject({ path: ".github/PULL_REQUEST_TEMPLATE/feature.md" });
  });
});
