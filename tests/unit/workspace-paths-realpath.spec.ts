/*
  Coverage for resolveExistingWorkspaceFile, the canonicalizing counterpart to the lexical
  resolveWorkspacePath. The property under test is a security one: a symlink that sits inside
  the workspace but points outside it passes the lexical check, and must still be refused by
  anything about to open the file.

  Symlink creation needs elevation or Developer Mode on Windows, so the link-dependent cases
  skip themselves rather than failing when the environment cannot create one.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExistingWorkspaceFile } from "../../src/workspace-paths.js";

let tmp: string;
let workspace: string;
let outside: string;

/** True when this platform/process can create symlinks at all. */
function canSymlink(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bls-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probeDir, "real.txt"), "x");
    fs.symlinkSync(path.join(probeDir, "real.txt"), path.join(probeDir, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bls-realpath-"));
  workspace = path.join(tmp, "workspace");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "inside.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(outside, "secrets.env"), "TOKEN=hunter2\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveExistingWorkspaceFile", () => {
  it("resolves a real file inside the workspace", () => {
    const resolved = resolveExistingWorkspaceFile("src/inside.ts", [workspace]);
    expect(resolved).not.toBeNull();
    expect(fs.readFileSync(resolved!, "utf8")).toContain("export const a");
  });

  it("refuses a path that escapes the workspace lexically", () => {
    expect(resolveExistingWorkspaceFile("../outside/secrets.env", [workspace])).toBeNull();
    expect(resolveExistingWorkspaceFile(path.join(outside, "secrets.env"), [workspace])).toBeNull();
  });

  it("refuses a file that does not exist even when the path is contained", () => {
    expect(resolveExistingWorkspaceFile("src/missing.ts", [workspace])).toBeNull();
  });

  it("refuses a directory", () => {
    expect(resolveExistingWorkspaceFile("src", [workspace])).toBeNull();
  });

  it("refuses an in-workspace symlink that points outside the workspace", () => {
    if (!canSymlink()) return;
    const link = path.join(workspace, "src", "escape.env");
    fs.symlinkSync(path.join(outside, "secrets.env"), link, "file");

    // The lexical containment check passes here — the link itself is under the workspace —
    // which is exactly why the physical path has to be checked as well.
    expect(resolveExistingWorkspaceFile("src/escape.env", [workspace])).toBeNull();
  });

  it("allows an in-workspace symlink that points back inside the workspace", () => {
    if (!canSymlink()) return;
    const link = path.join(workspace, "alias.ts");
    fs.symlinkSync(path.join(workspace, "src", "inside.ts"), link, "file");

    const resolved = resolveExistingWorkspaceFile("alias.ts", [workspace]);
    expect(resolved).not.toBeNull();
    expect(fs.readFileSync(resolved!, "utf8")).toContain("export const a");
  });

  it("still resolves files when the workspace root itself is reached through a symlink", () => {
    if (!canSymlink()) return;
    const linkedRoot = path.join(tmp, "linked-workspace");
    try {
      fs.symlinkSync(workspace, linkedRoot, "dir");
    } catch {
      return; // directory symlinks can be separately restricted
    }

    // Canonicalizing only the target would make every file look external here, since the
    // real file path can never sit under the link path — the roots get canonicalized too.
    const resolved = resolveExistingWorkspaceFile("src/inside.ts", [linkedRoot]);
    expect(resolved).not.toBeNull();
  });

  it("returns null when no workspace roots are supplied", () => {
    expect(resolveExistingWorkspaceFile("src/inside.ts", [])).toBeNull();
  });
});
