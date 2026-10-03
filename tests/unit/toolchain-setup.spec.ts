import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advise, requirementSummary } from "../../src/toolchains/advisor.js";
import { resolveNodeArchive, resolveTemurinArchive } from "../../src/toolchains/archives.js";
import { buildInstallScript, parseInstallResult } from "../../src/toolchains/install-script.js";
import { formatLocalToolchains, localToolchainsInPlay, type MachineInventory } from "../../src/toolchains/inventory.js";
import { buildInstallPlan } from "../../src/toolchains/plan.js";
import { needsForFiles, scanProjectNeeds, type ProjectNeeds } from "../../src/toolchains/project-needs.js";
import { archiveInstall, safePath, systemInstall, validVersion, venvFromInterpreter, type InstallStep } from "../../src/toolchains/recipes.js";
import { toolchainForCommand } from "../../src/toolchains/setup-controller.js";
import { parseVersionSpec, satisfies } from "../../src/toolchains/version-spec.js";

/* The guided setup is built for the workspace the original report came from: one window over a
   tree of many codebases, with mixed languages, conflicting version pins, and pins inherited from
   a parent folder. The fixture below is that shape in miniature. */

let root: string;

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-setup-"));
  // Python: a range, a pin, a Pipfile, an inherited .python-version, and one with its own venv.
  write("services/billing/pyproject.toml", '[project]\nname = "billing"\nrequires-python = ">=3.11,<3.14"\n');
  write("services/billing/uv.lock", "");
  write("services/ledger/pyproject.toml", '[project]\nname = "ledger"\n');
  write("services/ledger/.python-version", "3.9\n");
  write("services/ledger/requirements.txt", "requests\n");
  write("services/pipfile-app/Pipfile", '[requires]\npython_version = "3.12"\n');
  write("services/.python-version", "3.12\n");
  write("services/reports/setup.py", "from setuptools import setup\n");
  write("services/withvenv/pyproject.toml", '[project]\nrequires-python = ">=3.10"\n');
  write("services/withvenv/.venv/pyvenv.cfg", "version = 3.12.4\n");
  // Node: engines range, .nvmrc inherited from the frontend folder, a workspace with members, volta.
  write("frontend/.nvmrc", "20\n");
  write("frontend/web/package.json", JSON.stringify({ name: "web", dependencies: { react: "1" } }));
  write("frontend/web/package-lock.json", "{}");
  write("frontend/admin/package.json", JSON.stringify({ name: "admin", engines: { node: ">=22" }, dependencies: { vue: "1" } }));
  write("frontend/admin/pnpm-lock.yaml", "");
  write("tools/monorepo/package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"], devDependencies: { tsx: "1" } }));
  write("tools/monorepo/packages/a/package.json", JSON.stringify({ name: "a", dependencies: { lodash: "1" } }));
  write("tools/volta/package.json", JSON.stringify({ name: "v", volta: { node: "18.19.0" }, dependencies: { x: "1" } }));
  write("tools/volta/node_modules/.keep", "");
  // Go, .NET, Rust, Java, C/C++.
  write("go/api/go.mod", "module example.com/api\n\ngo 1.22\n\ntoolchain go1.22.3\n");
  write("go/legacy/go.mod", "module example.com/legacy\n\ngo 1.19\n");
  write("dotnet/Orders/Orders.csproj", "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>");
  write("dotnet/global.json", '{ "sdk": { "version": "8.0.100" } }');
  write("legacy-dotnet/Legacy/Legacy.csproj", "<Project><PropertyGroup><TargetFrameworks>net6.0;netstandard2.0</TargetFrameworks></PropertyGroup></Project>");
  write("rust/engine/Cargo.toml", '[package]\nname = "engine"\n');
  write("rust/engine/rust-toolchain.toml", '[toolchain]\nchannel = "1.75.0"\n');
  write("java/shop/pom.xml", "<project><properties><maven.compiler.release>17</maven.compiler.release></properties></project>");
  write("java/old/build.gradle", "java {\n  sourceCompatibility = JavaVersion.VERSION_1_8\n}\n");
  write("native/lib/CMakeLists.txt", "project(lib)\n");
  // .tool-versions at a folder above.
  write("polyglot/.tool-versions", "nodejs 22.4.0\ngolang 1.23.0\n");
  write("polyglot/svc/package.json", JSON.stringify({ name: "svc", dependencies: { y: "1" } }));
  // Things the scan must skip.
  write("frontend/web/node_modules/dep/package.json", JSON.stringify({ name: "dep" }));
  write(".hidden/package.json", "{}");
  write("frontend/web/.vscode/extensions.json", '{ // comment\n "recommendations": ["dbaeumer.vscode-eslint",] }');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function byDisplay(projects: readonly ProjectNeeds[], display: string): ProjectNeeds {
  const project = projects.find((candidate) => candidate.display === display);
  if (!project) throw new Error(`no project ${display} in ${projects.map((candidate) => candidate.display).join(", ")}`);
  return project;
}

function requirementRaw(project: ProjectNeeds, toolchain: string): string | undefined {
  return project.requirements.find((requirement) => requirement.toolchain === toolchain)?.spec.raw;
}

describe("version constraints", () => {
  it.each([
    [">=3.11,<3.14", "3.12.4", true],
    [">=3.11,<3.14", "3.14.0", false],
    [">= 3.10", "3.12.0", true],
    ["~=3.11", "3.12.1", true],
    ["~=3.11.2", "3.12.0", false],
    ["^20 || >=22", "21.1.0", false],
    ["^20 || >=22", "22.4.0", true],
    ["18.x", "18.19.0", true],
    ["3.12", "3.12.7", true],
    ["3.12", "3.13.0", false],
    ["lts/*", "16.0.0", true],
  ])("%s with %s → %s", (spec, version, expected) => {
    expect(satisfies(version, parseVersionSpec(spec))).toBe(expected);
  });
});

describe("what each project needs", () => {
  it("finds every project in a nested multi-codebase tree, and nothing in dependency or hidden folders", () => {
    const { projects, truncated } = scanProjectNeeds([root]);
    const displays = projects.map((project) => project.display).sort();
    expect(truncated).toBe(false);
    expect(displays).toContain("services/billing");
    expect(displays).toContain("tools/monorepo/packages/a");
    expect(displays).not.toContain("frontend/web/node_modules/dep");
    expect(displays.some((display) => display.startsWith(".hidden"))).toBe(false);
    expect(projects).toHaveLength(19);
  });

  it("reads each format of version requirement, citing the file and line", () => {
    const { projects } = scanProjectNeeds([root]);
    const billing = byDisplay(projects, "services/billing").requirements[0]!;
    expect(billing).toMatchObject({ toolchain: "Python", spec: { raw: ">=3.11,<3.14" }, evidence: { file: "services/billing/pyproject.toml", line: 3 } });
    expect(requirementRaw(byDisplay(projects, "services/ledger"), "Python")).toBe("3.9");
    expect(requirementRaw(byDisplay(projects, "services/pipfile-app"), "Python")).toBe("3.12");
    expect(requirementRaw(byDisplay(projects, "frontend/admin"), "Node")).toBe(">=22");
    expect(requirementRaw(byDisplay(projects, "tools/volta"), "Node")).toBe("18.19.0");
    expect(requirementRaw(byDisplay(projects, "go/api"), "Go")).toBe("1.22.3");
    expect(requirementRaw(byDisplay(projects, "go/legacy"), "Go")).toBe("go 1.19");
    expect(requirementRaw(byDisplay(projects, "legacy-dotnet/Legacy"), ".NET")).toBe("net6.0");
    expect(requirementRaw(byDisplay(projects, "rust/engine"), "Rust")).toBe("1.75.0");
    expect(requirementRaw(byDisplay(projects, "java/shop"), "Java")).toBe("17");
    expect(requirementRaw(byDisplay(projects, "java/old"), "Java")).toBe("1.8");
    expect(byDisplay(projects, "native/lib").toolchains).toEqual(["C/C++"]);
  });

  it("inherits a pin from a folder above when the project declares none", () => {
    const { projects } = scanProjectNeeds([root]);
    expect(byDisplay(projects, "frontend/web").requirements[0]).toMatchObject({ spec: { raw: "20" }, inherited: true, evidence: { file: "frontend/.nvmrc" } });
    expect(byDisplay(projects, "services/reports").requirements[0]).toMatchObject({ spec: { raw: "3.12" }, inherited: true });
    expect(byDisplay(projects, "dotnet/Orders").requirements[0]).toMatchObject({ spec: { raw: "8.0.100" }, inherited: true });
    expect(byDisplay(projects, "polyglot/svc").requirements[0]).toMatchObject({ spec: { raw: "22.4.0" }, evidence: { file: "polyglot/.tool-versions", line: 1 } });
  });

  it("knows each project's dependency step, and leaves workspace members to their root", () => {
    const { projects } = scanProjectNeeds([root]);
    expect(byDisplay(projects, "services/billing").dependencies[0]!.argv).toEqual(["uv", "sync"]);
    expect(byDisplay(projects, "services/ledger").dependencies[0]!.argv).toEqual(["python", "-m", "pip", "install", "-r", "requirements.txt"]);
    expect(byDisplay(projects, "frontend/web").dependencies[0]).toMatchObject({ argv: ["npm", "ci"], installed: true });
    expect(byDisplay(projects, "frontend/admin").dependencies[0]).toMatchObject({ argv: ["pnpm", "install", "--frozen-lockfile"], installed: false });
    expect(byDisplay(projects, "tools/monorepo/packages/a").dependencies).toEqual([]);
    expect(byDisplay(projects, "tools/volta").dependencies[0]!.installed).toBe(true);
    expect(byDisplay(projects, "services/withvenv").venv).toBe(".venv");
    expect(byDisplay(projects, "frontend/web").recommendedExtensions).toEqual(["dbaeumer.vscode-eslint"]);
  });

  it("finds just the projects owning given files, for the agent's per-turn context", () => {
    const owned = needsForFiles([root], [path.join(root, "services/billing/app/main.py"), path.join(root, "go/api/cmd/main.go")]);
    expect(owned.map((project) => project.display).sort()).toEqual(["go/api", "services/billing"]);
  });
});

const inventory: MachineInventory = {
  probedAt: Date.now(),
  pathKey: "k",
  installs: [
    { toolchain: "Python", command: "python3", path: "/usr/bin/python3", version: "3.9.6", source: "PATH" },
    { toolchain: "Python", command: "/opt/homebrew/bin/python3.12", path: "/opt/homebrew/bin/python3.12", version: "3.12.4", source: "Homebrew" },
    { toolchain: "Node", command: "node", path: "/usr/local/bin/node", version: "20.11.1", source: "PATH" },
    { toolchain: "Go", command: "go", path: "/usr/local/go/bin/go", version: "1.21.5", source: "PATH" },
    { toolchain: "Java", command: "java", path: "/usr/bin/java", version: "1.8.0_401", source: "PATH" },
  ],
  managers: ["brew"],
  missing: [".NET", "Rust", "C/C++"],
};

describe("recommendations", () => {
  function report(inPlay: string[] = []) {
    const { projects } = scanProjectNeeds([root]);
    return { projects, report: advise({ projects, inventory, platform: "darwin", installedExtensions: new Set(["ms-python.python"]), inPlayFiles: inPlay.map((file) => path.join(root, file)) }) };
  }

  it("reuses an installed version that is not first on PATH instead of installing another", () => {
    const { report: setup } = report();
    const billing = setup.projects.find((project) => project.display === "services/billing")!;
    expect(billing.items.find((item) => item.toolchain === "Python")).toMatchObject({ kind: "use_other", install: { version: "3.12.4" } });
    expect(setup.recommendations.some((recommendation) => recommendation.id === "system-Python")).toBe(false);
  });

  it("gives only the outliers a project-scoped copy when most projects are covered", () => {
    const { report: setup } = report();
    const admin = setup.recommendations.find((recommendation) => recommendation.id === "project-Node-frontend/admin");
    expect(admin).toMatchObject({ intent: { kind: "project_toolchain", toolchain: "Node", version: "24" } });
    expect(setup.recommendations.some((recommendation) => recommendation.id === "system-Node")).toBe(false);
  });

  it("suggests one system install when nothing is installed, pre-selected", () => {
    const { report: setup } = report();
    const dotnet = setup.recommendations.find((recommendation) => recommendation.id === "system-.NET");
    expect(dotnet).toMatchObject({ selected: true, intent: { kind: "system", toolchain: ".NET" } });
    expect(setup.toolchains.find((overview) => overview.toolchain === ".NET")?.summary).toContain("not installed");
  });

  it("lets Go fetch a newer pinned version by itself", () => {
    const { report: setup } = report();
    const api = setup.projects.find((project) => project.display === "go/api")!;
    expect(api.items.find((item) => item.toolchain === "Go")?.kind).toBe("auto");
  });

  it("pre-selects per-project work only for the projects in use", () => {
    const { report: setup } = report(["services/ledger/app.py"]);
    const ledgerVenv = setup.recommendations.find((recommendation) => recommendation.id === "venv-services/ledger");
    const otherVenv = setup.recommendations.find((recommendation) => recommendation.id === "venv-services/reports");
    expect(ledgerVenv?.selected).toBe(true);
    expect(otherVenv?.selected).toBe(false);
    // ledger pins 3.9: made from the installed 3.9.6, not fetched.
    expect(ledgerVenv?.intent).toMatchObject({ kind: "venv", interpreter: "/usr/bin/python3" });
  });

  it("asks for the tool a lockfile needs before the install that uses it", () => {
    const { report: setup } = report(["services/billing/app.py"]);
    const deps = setup.recommendations.find((recommendation) => recommendation.id === "deps-services/billing-uv");
    expect(deps?.needs).toContain("tool-uv");
    const order = setup.recommendations.map((recommendation) => recommendation.id);
    expect(order.indexOf("tool-uv")).toBeLessThan(order.indexOf("deps-services/billing-uv"));
  });

  it("offers editor extensions that are missing, and not ones already installed", () => {
    const { report: setup } = report();
    expect(setup.recommendations.some((recommendation) => recommendation.id === "extension-golang.go")).toBe(true);
    expect(setup.recommendations.some((recommendation) => recommendation.id === "extension-ms-python.python")).toBe(false);
  });

  it("tells the agent which versions the projects in play ask for and what fits", () => {
    const owned = needsForFiles([root], [path.join(root, "services/billing/main.py"), path.join(root, "frontend/admin/src/app.ts")]);
    const lines = requirementSummary(owned, inventory).join("\n");
    expect(lines).toContain("services/billing asks for Python >=3.11,<3.14 (services/billing/pyproject.toml:3): 3.12.4 at /opt/homebrew/bin/python3.12 fits");
    expect(lines).toContain("frontend/admin asks for Node >=22");
    expect(lines).toContain("nothing installed fits");
  });
});

describe("recipes refuse anything that could escape the script", () => {
  it("accepts only plain version numbers and absolute paths without line breaks", () => {
    expect(validVersion("3.12")).toBe(true);
    expect(validVersion("latest")).toBe(true);
    expect(validVersion("3.12; rm -rf ~")).toBe(false);
    expect(safePath("/work/svc")).toBe(true);
    expect(safePath("/work/svc\nrm -rf ~")).toBe(false);
    expect(safePath("relative/svc")).toBe(false);
    expect(systemInstall("Python", "3.12 && evil", { platform: "darwin", managers: ["brew"] })).toBeUndefined();
  });

  it("only downloads from the official hosts, with a real checksum", () => {
    const project = { dir: path.join(root, "frontend/admin"), display: "frontend/admin" };
    const good = { url: "https://nodejs.org/dist/v24.1.0/node-v24.1.0-darwin-arm64.tar.gz", sha256: "a".repeat(64), fileName: "node-v24.1.0-darwin-arm64.tar.gz", version: "24.1.0" };
    expect(archiveInstall("Node", project, good)).toBeDefined();
    expect(archiveInstall("Node", project, { ...good, url: "https://evil.example/node.tar.gz" })).toBeUndefined();
    expect(archiveInstall("Node", project, { ...good, sha256: "not-a-hash" })).toBeUndefined();
  });

  it("uses the user-scope Python installer on Windows, so no administrator prompt", () => {
    const step = systemInstall("Python", "3.13", { platform: "win32", managers: ["winget"] })!;
    expect(step.elevation).toBe("none");
    expect(step.commands[0]).toMatchObject({ kind: "run", argv: expect.arrayContaining(["Python.Python.3.13", "--scope", "user"]) });
    expect(systemInstall("Python", "3.13", { platform: "win32", managers: [] })).toBeUndefined();
  });
});

describe("the setup script", () => {
  const steps: InstallStep[] = [
    { id: "s1", phase: "system", title: "Install Go", target: "Homebrew", commands: [{ kind: "run", argv: ["brew", "install", "go"] }], elevation: "none", undo: "brew uninstall go", critical: true },
    venvFromInterpreter({ dir: path.resolve("/work/it's here"), display: "svc/api" }, path.resolve("/usr/bin/python3"), "3.12.4")!,
  ];

  for (const platform of ["win32", "darwin"] as const) {
    it(`previews every step and only proceeds on Y (${platform})`, () => {
      const script = buildInstallScript(steps, { platform, resultPath: "/tmp/r.json", cacheDir: "/tmp/cache" });
      expect(script).toContain("Proceed? Type Y to start, anything else to cancel");
      expect(script).toContain("Cancelled, nothing was changed.");
      expect(script).toContain("1. Install Go");
      expect(script).toContain("undo:  brew uninstall go");
      expect(script).toContain("[2/2] svc/api: Create .venv from Python 3.12.4");
      // A critical step stops the run; the project step is independent.
      expect(script).toContain("so the setup stops here");
      expect(script.match(/so the setup stops here/g)).toHaveLength(1);
    });
  }

  it("quotes paths with apostrophes for each shell", () => {
    const venv = path.join(path.resolve("/work/it's here"), ".venv");
    expect(buildInstallScript(steps, { platform: "win32", resultPath: "C:/r.json", cacheDir: "C:/c" })).toContain(`'${venv.replace(/'/g, "''")}'`);
    expect(buildInstallScript(steps, { platform: "linux", resultPath: "/r.json", cacheDir: "/c" })).toContain(`'${venv.replace(/'/g, "'\\''")}'`);
  });

  it("reads the result file, including PowerShell's byte-order mark", () => {
    expect(parseInstallResult('\uFEFF{"declined":false,"finished":true,"steps":[{"id":"s1","exitCode":0}]}')).toEqual({ declined: false, finished: true, steps: [{ id: "s1", exitCode: 0 }] });
    expect(parseInstallResult("not json")).toBeUndefined();
  });
});

describe("building the plan", () => {
  it("adds what a chosen step needs, and reports what it could not build", async () => {
    const { projects } = scanProjectNeeds([root]);
    const setup = advise({ projects, inventory, platform: "darwin", installedExtensions: new Set(), inPlayFiles: [] });
    const plan = await buildInstallPlan(setup, new Set(["deps-services/billing-uv", "project-Node-frontend/admin", "extension-golang.go"]), {
      platform: "darwin", arch: "arm64", managers: inventory.managers, projects,
      resolveNode: async () => { throw new Error("offline"); },
      resolveTemurin: async () => { throw new Error("offline"); },
    });
    expect(plan.steps.map((step) => step.id)).toEqual(["prereq-uv", "deps-services/billing-uv"]);
    expect(plan.added).toEqual(["Install uv"]);
    expect(plan.extensions).toEqual(["golang.go"]);
    expect(plan.problems.join(" ")).toContain("could not look up the download (offline)");
  });
});

describe("project-local toolchains", () => {
  it("tells the agent about a Node unpacked inside the project, by path", () => {
    const nodeDir = path.join(root, "frontend/admin/.toolchains/node-v24.1.0-test");
    const executable = process.platform === "win32" ? path.join(nodeDir, "node.exe") : path.join(nodeDir, "bin", "node");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "");
    const lines = formatLocalToolchains(localToolchainsInPlay(root, ["frontend/admin/src/app.ts"])).join("\n");
    expect(lines).toContain("Project frontend/admin has its own Node 24.1.0");
    expect(lines).toContain("not on PATH; call it by this path");
  });
});

describe("archive lookup", () => {
  const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });

  it("pins Node to the checksum the release publishes", async () => {
    const fetchImpl = async (url: string) => url.endsWith("index.json")
      ? respond([{ version: "v24.2.0" }, { version: "v22.9.0" }])
      : respond(`${"b".repeat(64)}  node-v22.9.0-linux-x64.tar.xz\n${"c".repeat(64)}  node-v22.9.0-win-x64.zip\n`);
    const archive = await resolveNodeArchive("22", "linux", "x64", fetchImpl);
    expect(archive).toEqual({ url: "https://nodejs.org/dist/v22.9.0/node-v22.9.0-linux-x64.tar.xz", sha256: "b".repeat(64), fileName: "node-v22.9.0-linux-x64.tar.xz", version: "22.9.0" });
  });

  it("takes the JDK link and checksum from Adoptium", async () => {
    const fetchImpl = async () => respond([{ binary: { package: { link: "https://github.com/adoptium/temurin21-binaries/releases/download/x/OpenJDK21.zip", checksum: "D".repeat(64), name: "OpenJDK21.zip" } }, version: { semver: "21.0.5+11" } }]);
    const archive = await resolveTemurinArchive("21", "win32", "x64", fetchImpl);
    expect(archive).toMatchObject({ sha256: "d".repeat(64), fileName: "OpenJDK21.zip", version: "21.0.5+11" });
  });
});

describe("missing-command offers", () => {
  it.each([["python3", "Python"], ["npm", "Node"], ["mvn", "Java"], ["dotnet", ".NET"], ["cargo", "Rust"], ["cmake", "C/C++"], ["kubectl", undefined]])(
    "%s belongs to %s", (command, toolchain) => { expect(toolchainForCommand(command)).toBe(toolchain); },
  );
});
