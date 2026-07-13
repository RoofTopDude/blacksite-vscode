import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceInstructions } from "../../src/workspace-context.js";

const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-instructions-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("readWorkspaceInstructions", () => {
  it("loads root guidance independent of the active model provider", () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, ".github"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Use the project test harness.");
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "Preserve public contracts.");
    fs.writeFileSync(path.join(root, ".github", "copilot-instructions.md"), "Prefer narrow diffs.");

    const result = readWorkspaceInstructions(root);

    expect(result).toContain("--- AGENTS.md ---");
    expect(result).toContain("Use the project test harness.");
    expect(result).toContain("Preserve public contracts.");
    expect(result).toContain("Prefer narrow diffs.");
  });

  it("adds instructions scoped to the active file's ancestor chain", () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, "apps", "api", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Root policy.");
    fs.writeFileSync(path.join(root, "apps", "AGENTS.md"), "Apps policy.");
    fs.writeFileSync(path.join(root, "apps", "api", "AGENTS.md"), "API policy.");

    const result = readWorkspaceInstructions(root, "apps/api/src/server.ts");

    expect(result).toContain("Root policy.");
    expect(result).toContain("--- apps/api/AGENTS.md ---");
    expect(result).toContain("API policy.");
    expect(result.indexOf("Root policy.")).toBeLessThan(result.indexOf("Apps policy."));
    expect(result.indexOf("Apps policy.")).toBeLessThan(result.indexOf("API policy."));
  });

  it("ignores an active path that escapes the workspace", () => {
    const root = tempWorkspace();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Root only.");

    expect(readWorkspaceInstructions(root, "../outside/file.ts")).toContain("Root only.");
    expect(readWorkspaceInstructions(root, "../outside/file.ts")).not.toContain("outside/AGENTS.md");
  });
});
