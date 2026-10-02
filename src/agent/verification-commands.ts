/* Which shell commands count as a check of the agent's own changes.

   ── Why this exists ─────────────────────────────────────────────────────────
   The verification gate used to recognise a check by a keyword in shell_run's `command` alone.
   But `command` is only the executable: `pytest`, `mypy` and `ruff check` carry no keyword,
   and `npm test` puts its keyword in `args`. Real checks were not counted, the gate kept asking
   for a check the agent had already run, and the only thing that reliably satisfied it was a
   binary whose *path* happened to contain "verify".

   This reads the whole command line the way a person would: through the wrappers that only
   launch something else (`uv run`, `npx`, `python -m`, `bash -lc "…"`), to the program that does
   the checking and the subcommand it was given. Pure, so it can be tested without a session. */

/** Programs that are a check whatever their arguments. */
const CHECKERS = new Set([
  "pytest", "py.test", "mypy", "pyright", "basedpyright", "flake8", "pylint", "tox", "nox",
  "tsc", "vue-tsc", "eslint", "biome", "vitest", "jest", "mocha", "ava", "rspec", "phpunit",
  "golangci-lint", "staticcheck", "ctest", "shellcheck", "hadolint", "yamllint", "markdownlint",
  "stylelint", "rubocop", "phpstan", "psalm", "ktlint", "detekt", "swiftlint",
]);

/** Programs that check only under certain subcommands (`go test`, not `go run`). */
const SUBCOMMAND_CHECKERS: Record<string, ReadonlySet<string>> = {
  go: new Set(["test", "vet", "build"]),
  cargo: new Set(["test", "check", "clippy", "build", "nextest"]),
  dotnet: new Set(["test", "build"]),
  mvn: new Set(["test", "verify", "compile", "package", "check"]),
  mvnw: new Set(["test", "verify", "compile", "package", "check"]),
  gradle: new Set(["test", "check", "build", "compilejava", "compilekotlin"]),
  gradlew: new Set(["test", "check", "build", "compilejava", "compilekotlin"]),
  ruff: new Set(["check"]),
  black: new Set(["--check"]),
  make: new Set(["test", "check", "lint", "verify", "typecheck"]),
  swift: new Set(["test", "build"]),
  deno: new Set(["test", "check", "lint"]),
  bun: new Set(["test"]),
  playwright: new Set(["test"]),
  node: new Set(["--test"]),
};

/** Package-manager scripts whose name says they check something. */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const CHECK_SCRIPT = /(^|[:_-])(test|tests|lint|typecheck|type-check|check|verify|tsc|ci)([:_-]|$)/i;

/** Wrappers that only launch the program named after them. */
const LAUNCHERS: Record<string, readonly string[]> = {
  uv: ["run"], poetry: ["run"], pipenv: ["run"], hatch: ["run"], pdm: ["run"], rye: ["run"],
  npx: [], bunx: [], pnpx: [], pnpm: ["exec", "dlx"], yarn: ["dlx", "exec"],
  conda: ["run"], dotenv: [], env: [], time: [], nice: [],
};

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "cmd", "pwsh", "powershell"]);
const PYTHONS = new Set(["python", "python3", "py", "pypy", "pypy3"]);

/** The legacy rule, kept so nothing that counted before stops counting. */
const KEYWORD = /\b(test|lint|typecheck|check|verify)\b/i;

/** Lower-cased executable name with any directory and Windows extension removed. */
export function programName(value: string): string {
  const base = value.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
}

/** Split a shell line into the commands it runs, then each command into words. Quotes are honoured
 *  well enough for the purpose here: recognising a program and its subcommand. */
function splitShellLine(line: string): string[][] {
  return line
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, "")))
    .filter((words) => words.length > 0);
}

/** Skip leading `VAR=value` assignments and option flags a launcher takes before the program. */
function dropLeadingNoise(words: readonly string[]): string[] {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  return words.slice(index);
}

function isCheck(words: readonly string[], depth: number): boolean {
  if (depth > 4) return false;
  const [head, ...rest] = dropLeadingNoise(words);
  if (!head) return false;
  const name = programName(head);

  if (SHELLS.has(name)) {
    const flagIndex = rest.findIndex((arg) => /^(-[a-z]*c|\/c|\/k|-command|-c)$/i.test(arg));
    const line = flagIndex >= 0 ? rest.slice(flagIndex + 1).join(" ") : "";
    return line ? splitShellLine(line).some((segment) => isCheck(segment, depth + 1)) : false;
  }
  if (PYTHONS.has(name)) {
    const moduleIndex = rest.indexOf("-m");
    if (moduleIndex >= 0 && rest[moduleIndex + 1]) return isCheck(rest.slice(moduleIndex + 1), depth + 1);
  }
  const launcher = LAUNCHERS[name];
  if (launcher) {
    const sub = rest[0]?.toLowerCase();
    if (launcher.length === 0) {
      let start = 0;
      while (start < rest.length && rest[start]!.startsWith("-")) start += 1;
      return isCheck(rest.slice(start), depth + 1);
    }
    if (sub && launcher.includes(sub)) return isCheck(rest.slice(1), depth + 1);
  }
  if (CHECKERS.has(name)) return true;
  const subcommands = SUBCOMMAND_CHECKERS[name];
  if (subcommands && rest.some((arg) => subcommands.has(arg.toLowerCase()))) return true;
  if (SCRIPT_RUNNERS.has(name)) {
    const args = rest.filter((arg) => !arg.startsWith("-"));
    const script = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
    if (script && CHECK_SCRIPT.test(script)) return true;
  }
  return false;
}

/**
 * Whether running `command` with `args` checks code: a test runner, type checker, linter or
 * build, directly or through a launcher or an explicit shell line.
 */
export function isVerificationCommand(command: string, args: readonly string[] = []): boolean {
  if (!command.trim()) return false;
  if (isCheck([command, ...args], 0)) return true;
  // Only the executable, as before: over the arguments it would count `rm -rf test` as a check.
  return KEYWORD.test(command);
}
