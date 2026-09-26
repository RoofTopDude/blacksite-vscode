import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeToolchainRoots, type ToolchainRoots } from "../../packages/local-runtime/src/toolchain-roots.js";
import { copyPath, glob, listDirectory, readFile, searchFiles, writeFile } from "../../packages/local-runtime/src/file-ops.js";
import { externalPathArgs, resolveShellConfirmation } from "../../packages/local-runtime/src/security.js";
import { handleShell } from "../../packages/local-runtime/src/shell.js";
import { LocalRuntime } from "../../packages/local-runtime/src/runtime.js";

/* Globally installed software — an interpreter, its standard library, global packages — lives
   outside the workspace, and the agent could run it but not read it or name its paths. These pin
   the replacement rule: installed toolchains are readable, anything else outside the workspace
   asks first, and nothing outside the workspace is ever written. */

let base: string;
let home: string;
let workspace: string;
let roots: ToolchainRoots;
const p = (...parts: string[]): string => path.join(base, ...parts);

function write(file: string, content = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bls-toolchains-")));
  home = p("home");
  workspace = p("home", "projects", "app");
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(workspace, "main.py"), "import json\n");

  // A Windows-style Python install: the install dir itself and its Scripts dir are on PATH.
  write(p("Python312", "python.exe"), "");
  write(p("Python312", "Lib", "json", "__init__.py"), "def loads(s): ...\n");
  write(p("Python312", "Lib", "site-packages", "requests", "api.py"), "def get(url): ...\n");
  fs.mkdirSync(p("Python312", "Scripts"), { recursive: true });
  // A POSIX-style prefix outside home: bin on PATH, libraries beside it, service state too.
  write(p("prefix", "bin", "node"), "");
  write(p("prefix", "lib", "node_modules", "npm", "index.js"), "module.exports = 1;\n");
  write(p("prefix", "share", "doc", "readme.txt"), "docs\n");
  write(p("prefix", "etc", "service.conf"), "password=hunter2\n");
  // Installs inside home: only their library folders count.
  write(p("home", ".cargo", "bin", "cargo"), "");
  write(p("home", ".cargo", "credentials.toml"), "token = \"secret\"\n");
  write(p("home", ".local", "bin", "pipx"), "");
  write(p("home", ".local", "lib", "python3.12", "site-packages", "mod.py"), "x = 1\n");
  write(p("home", ".local", "share", "keyrings", "login.keyring"), "secret\n");
  write(p("home", ".ssh", "id_rsa"), "PRIVATE KEY\n");
  // Somewhere outside the workspace that is not an installed toolchain.
  write(p("elsewhere", "notes.txt"), "outside\n");

  const pathValue = [
    p("Python312"), p("Python312", "Scripts"), p("prefix", "bin"),
    p("home", ".cargo", "bin"), p("home", ".local", "bin"),
    home,                                   // the home directory itself: never a root
    path.join(workspace, "node_modules", ".bin"), // inside the workspace: already readable
    "relative/bin",                         // not absolute: ignored
  ].join(path.delimiter);
  roots = computeToolchainRoots({ workspaceRoot: workspace, pathValue, homeDir: home });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const within = (list: string[], dir: string): boolean =>
  list.some((entry) => path.relative(entry, dir) === "" && entry.toLowerCase() === dir.toLowerCase());

describe("computeToolchainRoots", () => {
  it("takes PATH directories and the library folders of the installs they belong to", () => {
    expect(within(roots.readable, p("Python312"))).toBe(true);
    expect(within(roots.readable, p("prefix", "bin"))).toBe(true);
    expect(within(roots.readable, p("prefix", "lib"))).toBe(true);
    expect(within(roots.readable, p("prefix", "share"))).toBe(true);
    expect(within(roots.readable, p("home", ".local", "lib"))).toBe(true);
  });

  it("never takes service state, user data, credentials, home itself, or the workspace", () => {
    for (const excluded of [
      p("prefix"), p("prefix", "etc"), home, p("home", ".cargo"), p("home", ".local"),
      p("home", ".local", "share"), p("home", ".ssh"), workspace, path.join(workspace, "node_modules", ".bin"),
    ]) {
      expect(roots.readable.some((root) => path.relative(root, excluded) === "" || !path.relative(root, excluded).startsWith("..") && !path.isAbsolute(path.relative(root, excluded))), excluded)
        .toBe(false);
    }
  });

  it("lists the PATH directories themselves as executable locations", () => {
    expect(within(roots.executableDirs, p("Python312"))).toBe(true);
    expect(within(roots.executableDirs, p("prefix", "bin"))).toBe(true);
    expect(within(roots.executableDirs, home)).toBe(false);
  });

  it("adds user-configured roots but still refuses one that contains the home directory", () => {
    const configured = computeToolchainRoots({
      workspaceRoot: workspace, pathValue: "", homeDir: home, extraRoots: ["~/.local/share/fonts-not-there", p("elsewhere"), base],
    });
    expect(within(configured.readable, p("elsewhere"))).toBe(true);
    expect(within(configured.readable, base)).toBe(false);
  });

  it("can be switched off, leaving only configured roots", () => {
    const off = computeToolchainRoots({ workspaceRoot: workspace, pathValue: p("Python312"), homeDir: home, includePath: false });
    expect(off).toEqual({ readable: [], executableDirs: [] });
  });
});

describe("file tools outside the workspace", () => {
  const access = () => ({ readableRoots: roots.readable });

  it("reads an installed toolchain directly — the standard library and site-packages", () => {
    const stdlib = readFile(workspace, p("Python312", "Lib", "json", "__init__.py"), {}, access());
    expect(stdlib).toMatchObject({ ok: true, content: "def loads(s): ..." });
    expect(listDirectory(workspace, p("Python312", "Lib", "site-packages"), 50, access())).toMatchObject({ ok: true });
    expect(glob(workspace, p("Python312", "Lib"), "**/*.py", 50, {}, access())).toMatchObject({ ok: true });
    const found = searchFiles(workspace, p("Python312", "Lib", "site-packages"), "def get", {}, access());
    expect(found).toMatchObject({ ok: true, totalMatches: 1 });
  });

  it("asks before reading anywhere else outside the workspace, and reads once approved", () => {
    for (const result of [
      readFile(workspace, p("elsewhere", "notes.txt"), {}, access()),
      readFile(workspace, p("home", ".ssh", "id_rsa"), {}, access()),
      readFile(workspace, p("prefix", "etc", "service.conf"), {}, access()),
      readFile(workspace, p("home", ".cargo", "credentials.toml"), {}, access()),
      listDirectory(workspace, p("elsewhere"), 50, access()),
    ]) {
      expect(result).toMatchObject({ ok: false, requiresConfirmation: true, tier: "read" });
      expect((result as { description: string }).description).toMatch(/outside the workspace/);
    }
    expect(readFile(workspace, p("elsewhere", "notes.txt"), {}, { ...access(), confirmed: true }))
      .toMatchObject({ ok: true, content: "outside" });
  });

  it("follows a workspace link into a toolchain, and names the target of one that leads elsewhere", () => {
    fs.symlinkSync(p("Python312", "Lib"), path.join(workspace, "pylib"), "junction");
    fs.symlinkSync(p("elsewhere"), path.join(workspace, "linked"), "junction");
    expect(readFile(workspace, "pylib/json/__init__.py", {}, access())).toMatchObject({ ok: true });
    const linked = readFile(workspace, "linked/notes.txt", {}, access());
    expect(linked).toMatchObject({ ok: false, requiresConfirmation: true });
    expect((linked as { description: string }).description).toContain("a link to");
  });

  it("never writes outside the workspace, toolchain or not", () => {
    for (const target of [p("Python312", "Lib", "json", "__init__.py"), p("elsewhere", "planted.txt")]) {
      expect(writeFile(workspace, target, "planted", true)).toMatchObject({ ok: false, error: expect.stringMatching(/escapes the workspace/) });
    }
    expect(fs.readFileSync(p("Python312", "Lib", "json", "__init__.py"), "utf8")).toBe("def loads(s): ...\n");
  });

  it("copies from outside only with approval that names where it comes from", () => {
    const pending = copyPath(workspace, p("elsewhere", "notes.txt"), "copied.txt", false, false, access());
    expect(pending).toMatchObject({ ok: false, requiresConfirmation: true });
    expect((pending as { description: string }).description).toMatch(/notes\.txt \(outside the workspace\) → copied\.txt/);
  });
});

describe("shell commands that name paths outside the workspace", () => {
  const accessFor = (command: string, args: string[]) => ({
    externalPaths: externalPathArgs(command, args, { workspaceRoot: workspace, cwd: workspace, readableRoots: roots.readable }),
    executableDirs: roots.executableDirs,
  });

  it("lets a read-only inspector look into an installed toolchain without asking", () => {
    const args = [p("Python312", "Lib", "site-packages", "requests", "api.py")];
    expect(resolveShellConfirmation("cat", args, false, undefined, {}, accessFor("cat", args))).toMatchObject({ kind: "proceed" });
  });

  it("asks — naming the path — instead of refusing an argument that leads elsewhere", () => {
    for (const [command, args] of [
      ["cat", [p("home", ".ssh", "id_rsa")]],
      ["rg", ["secret", ".."]],
      ["ls", [p("elsewhere")]],
    ] as Array<[string, string[]]>) {
      const outcome = resolveShellConfirmation(command, args, false, undefined, {}, accessFor(command, args));
      expect(outcome, `${command} ${args.join(" ")}`).toMatchObject({ kind: "confirm" });
      if (outcome.kind === "confirm") expect(outcome.description).toMatch(/reaches outside the workspace/);
    }
  });

  it("asks when a toolchain path meets a command that could write into it", () => {
    const target = p("Python312", "Lib", "json", "__init__.py");
    for (const [command, args] of [["cp", ["main.py", target]], ["sort", ["-o", target, "main.py"]]] as Array<[string, string[]]>) {
      expect(resolveShellConfirmation(command, args, false, undefined, {}, accessFor(command, args)), command)
        .toMatchObject({ kind: "confirm" });
    }
  });

  it("lets an always-allowed binary use a toolchain, but still asks before it reaches other outside data", () => {
    const policy = { autoApprove: ["python"] };
    const toolchainArgs = [p("Python312", "Lib", "json", "__init__.py")];
    expect(resolveShellConfirmation("python", toolchainArgs, false, undefined, policy, accessFor("python", toolchainArgs)))
      .toMatchObject({ kind: "proceed" });
    const outsideArgs = [p("elsewhere", "notes.txt")];
    expect(resolveShellConfirmation("python", outsideArgs, false, undefined, policy, accessFor("python", outsideArgs)))
      .toMatchObject({ kind: "confirm" });
  });

  it("identifies an interpreter named by its full path in a PATH directory like its bare name", () => {
    const interpreter = p("Python312", "python.exe");
    const access = { executableDirs: roots.executableDirs };
    expect(resolveShellConfirmation(interpreter, ["main.py"], false, undefined, { autoApprove: ["python"] }, access))
      .toMatchObject({ kind: "proceed" });
    // Outside a PATH directory it is still unrecognized code.
    const loose = write(p("elsewhere", "python.exe"), "");
    expect(resolveShellConfirmation(loose, ["main.py"], false, undefined, { autoApprove: ["python"] }, access))
      .toMatchObject({ kind: "confirm", unrecognizedCommand: true });
  });

  it("treats a /switch:value as a switch, never a path", () => {
    expect(externalPathArgs("dotnet", ["build", "/p:Configuration=Release"], { workspaceRoot: workspace, cwd: workspace })).toEqual([]);
  });

  it("starts a background process that names an outside path only after approval", async () => {
    const runtime = new LocalRuntime(workspace);
    const response = await runtime.handleMessage({
      type: "system.process.start",
      payload: { command: "cat", args: [p("elsewhere", "notes.txt")] },
    });
    expect(response.result).toMatchObject({ ok: true, requiresConfirmation: true });
  });
});

describe.runIf(process.platform === "win32")("Windows switches are not paths", () => {
  /* `/t` resolves to C:\t, so these all failed as "outside the workspace" — including the
     `cmd /c` form the shell tool itself tells the model to use. */
  it("runs where /q and cmd /c", async () => {
    for (const payload of [
      { command: "where", args: ["/q", "cmd"] },
      { command: "cmd", args: ["/c", "echo switch-ok"], confirmed: true },
    ]) {
      const result = await handleShell(payload, workspace);
      expect(result, payload.command).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty("requiresConfirmation");
    }
  });

  it("reads switches for a program under the Windows directory, not for a GNU port of it", () => {
    const windowsDir = process.env.SystemRoot ?? "C:\\Windows";
    const native = path.join(windowsDir, "System32", "timeout.exe");
    expect(externalPathArgs("timeout", ["/t", "5", "/nobreak"], { workspaceRoot: workspace, cwd: workspace, resolvedCommand: native }))
      .toEqual([]);
    // Git for Windows' GNU timeout would read `/t` as its duration argument, not a switch.
    const gnu = "C:\\Program Files\\Git\\usr\\bin\\timeout.exe";
    expect(externalPathArgs("timeout", ["/t", "5"], { workspaceRoot: workspace, cwd: workspace, resolvedCommand: gnu }))
      .toHaveLength(1);
  });

  it("still judges /word as a path for a program that reads it as one", () => {
    const outside = externalPathArgs("rg", ["secret", "/Users"], { workspaceRoot: workspace, cwd: workspace });
    expect(outside).toHaveLength(1);
  });
});

describe("code navigation into installed toolchains", () => {
  it("keeps a definition in site-packages, and still drops one elsewhere outside the workspace", async () => {
    const vscode = await import("vscode");
    const { LspService } = await import("../../src/lsp-service.js");
    const workspaceApi = vscode.workspace as unknown as { workspaceFolders: unknown };
    const previous = workspaceApi.workspaceFolders;
    workspaceApi.workspaceFolders = [{ name: "app", index: 0, uri: vscode.Uri.file(workspace) }];
    try {
      const service = new LspService(workspace, {} as never, () => roots.readable) as unknown as {
        _isReadableLocation(uri: unknown, readableRoots: readonly string[]): boolean;
      };
      const at = (file: string) => vscode.Uri.file(file);
      expect(service._isReadableLocation(at(path.join(workspace, "main.py")), roots.readable)).toBe(true);
      expect(service._isReadableLocation(at(p("Python312", "Lib", "site-packages", "requests", "api.py")), roots.readable)).toBe(true);
      expect(service._isReadableLocation(at(p("elsewhere", "notes.txt")), roots.readable)).toBe(false);
      expect(service._isReadableLocation(at(p("home", ".ssh", "id_rsa")), roots.readable)).toBe(false);
    } finally {
      workspaceApi.workspaceFolders = previous;
    }
  });
});
