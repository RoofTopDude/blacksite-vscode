import { describe, expect, it } from "vitest";
import { isVerificationCommand, programName } from "../../src/agent/verification-commands.js";

describe("isVerificationCommand", () => {
  it.each([
    ["pytest", []],
    ["pytest", ["services/billing/tests", "-q"]],
    ["mypy", ["src"]],
    ["ruff", ["check", "."]],
    ["npm", ["test"]],
    ["npm", ["run", "typecheck"]],
    ["pnpm", ["run", "lint:host"]],
    ["yarn", ["test:unit"]],
    ["uv", ["run", "pytest", "-x"]],
    ["poetry", ["run", "mypy", "."]],
    ["python", ["-m", "pytest"]],
    ["python3", ["-m", "mypy", "pkg"]],
    ["npx", ["--yes", "vitest", "run"]],
    ["pnpm", ["exec", "tsc", "--noEmit"]],
    ["go", ["test", "./..."]],
    ["cargo", ["clippy"]],
    ["dotnet", ["test"]],
    ["./gradlew", ["check"]],
    ["mvn", ["-q", "verify"]],
    ["bash", ["-lc", "cd services/a && pytest -q"]],
    ["cmd", ["/c", "npm test"]],
    ["C:\\tools\\Python312\\Scripts\\pytest.exe", []],
    ["services/a/.venv/bin/pytest", ["-q"]],
    ["env", ["CI=1", "pytest"]],
  ])("counts %s %j", (command, args) => {
    expect(isVerificationCommand(command, args)).toBe(true);
  });

  it.each([
    ["ls", ["tests"]],
    ["rm", ["-rf", "test"]],
    ["git", ["log", "--grep", "verify"]],
    ["go", ["run", "."]],
    ["cargo", ["run"]],
    ["ruff", ["format", "."]],
    ["npm", ["install"]],
    ["python", ["scripts/migrate.py"]],
    ["bash", ["-lc", "echo hi"]],
    ["uv", ["sync"]],
  ])("does not count %s %j", (command, args) => {
    expect(isVerificationCommand(command, args)).toBe(false);
  });

  it("keeps counting an executable whose own name says it checks", () => {
    expect(isVerificationCommand("./scripts/verify.sh")).toBe(true);
    expect(isVerificationCommand("run-lint")).toBe(true);
  });
});

describe("programName", () => {
  it("strips directories and Windows extensions", () => {
    expect(programName("C:\\x\\npm.cmd")).toBe("npm");
    expect(programName("/usr/bin/python3")).toBe("python3");
  });
});
