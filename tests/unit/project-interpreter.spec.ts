import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectVenv, resolveProjectPythonTool, venvExecutable, venvPythonVersion,
} from "../../packages/local-runtime/src/project-interpreter.js";

/* A workspace holding several projects, each with its own virtualenv, the way a single window over
   many codebases looks. A bare `pytest` must run the owning project's copy, never a sibling's. */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function makeVenv(root: string, relative: string, tools: string[], version = "3.12.4"): string {
  const venv = path.join(root, relative);
  const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(venv, "pyvenv.cfg"), `home = /usr/bin\nversion = ${version}\n`);
  for (const tool of tools) fs.writeFileSync(path.join(bin, process.platform === "win32" ? `${tool}.exe` : tool), "");
  return venv;
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-venv-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "services", "billing", "tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "services", "auth", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps", "web"), { recursive: true });
  return root;
}

describe("project virtualenv resolution", () => {
  it("finds the nearest virtualenv above a directory, within the workspace", () => {
    const root = workspace();
    const billing = makeVenv(root, "services/billing/.venv", ["python", "pytest"]);
    expect(findProjectVenv(path.join(root, "services", "billing", "tests"), root)).toBe(billing);
    expect(findProjectVenv(path.join(root, "apps", "web"), root)).toBeUndefined();
  });

  it("never picks up a sibling project's environment", () => {
    const root = workspace();
    makeVenv(root, "services/billing/.venv", ["pytest"]);
    expect(resolveProjectPythonTool("pytest", [], path.join(root, "services", "auth"), root)).toBeUndefined();
  });

  it("runs a bare tool from the owning project's environment", () => {
    const root = workspace();
    const billing = makeVenv(root, "services/billing/.venv", ["python", "pytest"]);
    const resolved = resolveProjectPythonTool("pytest", ["-q"], path.join(root, "services", "billing"), root);
    expect(resolved?.venv).toBe(billing);
    expect(resolved?.executable).toBe(venvExecutable(billing, "pytest"));
  });

  it("anchors on a path argument when the command runs from the workspace root", () => {
    const root = workspace();
    makeVenv(root, "services/auth/.venv", ["mypy"]);
    const billing = makeVenv(root, "services/billing/venv", ["pytest"]);
    expect(resolveProjectPythonTool("pytest", ["services/billing/tests", "-x"], root, root)?.venv).toBe(billing);
  });

  it("leaves every other command to the ordinary PATH lookup", () => {
    const root = workspace();
    makeVenv(root, ".venv", ["git", "python"]);
    expect(resolveProjectPythonTool("git", ["status"], root, root)).toBeUndefined();
  });

  it("reads the version a virtualenv was created with", () => {
    const root = workspace();
    expect(venvPythonVersion(makeVenv(root, ".venv", [], "3.11.9"))).toBe("3.11.9");
  });
});
