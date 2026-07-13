import { copyFile, cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionSourcePath = path.resolve(here, "../../..");
const extensionTestsSourcePath = path.join(here, "suite.cjs");
const fixtureSource = path.join(here, "fixture");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "blacksite-lsp-integration-"));
const fixtureWorkspace = path.join(temporaryRoot, "workspace");
const extensionDevelopmentPath = path.join(temporaryRoot, "extension");
const extensionTestsPath = path.join(temporaryRoot, "suite.cjs");

// Some VS Code-integrated terminals inherit this flag. Leaving it set makes
// Code.exe run as a Node process and interpret the fixture folder as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await cp(fixtureSource, fixtureWorkspace, { recursive: true });
  await symlink(extensionSourcePath, extensionDevelopmentPath, "junction");
  await copyFile(extensionTestsSourcePath, extensionTestsPath);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    version: process.env.VSCODE_TEST_VERSION || "stable",
    launchArgs: [
      fixtureWorkspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-release-notes",
      "--skip-welcome",
      `--user-data-dir=${path.join(temporaryRoot, "user-data")}`,
      `--extensions-dir=${path.join(temporaryRoot, "extensions")}`,
    ],
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
