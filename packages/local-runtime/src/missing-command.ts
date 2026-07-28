/**
 * Missing-executable detection and install guidance.
 *
 * A `spawn` that fails with ENOENT means the binary is not on PATH — the command never
 * ran at all. Reported as a plain empty result it is indistinguishable from a command
 * that ran and printed nothing, so the agent would keep re-issuing it (and re-issuing
 * whatever it was a prerequisite for) until the iteration cap ended the turn. Everything
 * here exists to make that state unmistakable in one shot: name the tool, say it is not
 * installed, and hand back the exact command that would install it on this platform.
 *
 * Kept free of `vscode` imports so it stays usable from the runtime package; the editor
 * side consumes `installHint` to offer the user a one-click path (see chat-provider).
 */

/** How a missing tool is installed on one platform. */
export interface InstallOption {
  /** Package manager driving the install ("winget", "brew", "apt", …). */
  manager: string;
  /** The literal command to run. Shown to the user; never executed automatically. */
  command: string;
}

export interface InstallHint {
  /** The executable that was missing, as spawned ("npm", "brew", …). */
  command: string;
  /** What the tool is, in one clause — the agent may be picking an alternative. */
  summary: string;
  /** Platform-appropriate install commands, best first. Empty when we know of none. */
  options: InstallOption[];
  /** Canonical download/instructions page. */
  docsUrl?: string;
  /** Sibling binaries that arrive with the same install (npm ships with node, …). */
  provides?: string[];
}

interface ToolSpec {
  summary: string;
  docsUrl?: string;
  provides?: string[];
  win32?: InstallOption[];
  darwin?: InstallOption[];
  linux?: InstallOption[];
}

/* Node's own toolchain: npm/npx/node all arrive together, so all three point at one
   install. This is by far the most common miss — an agent reaches for `npm install`
   or `npx` on a machine that has neither. */
const NODE_TOOLCHAIN: ToolSpec = {
  summary: "Node.js runtime and its bundled package tools (node, npm, npx)",
  docsUrl: "https://nodejs.org/en/download",
  provides: ["node", "npm", "npx"],
  win32: [
    { manager: "winget", command: "winget install OpenJS.NodeJS.LTS" },
    { manager: "choco", command: "choco install nodejs-lts" },
  ],
  darwin: [{ manager: "brew", command: "brew install node" }],
  linux: [
    { manager: "apt", command: "sudo apt-get install -y nodejs npm" },
    { manager: "dnf", command: "sudo dnf install -y nodejs npm" },
  ],
};

const PYTHON_TOOLCHAIN: ToolSpec = {
  summary: "Python interpreter and its bundled package installer (python, pip)",
  docsUrl: "https://www.python.org/downloads/",
  provides: ["python", "python3", "pip", "pip3"],
  win32: [{ manager: "winget", command: "winget install Python.Python.3.12" }],
  darwin: [{ manager: "brew", command: "brew install python" }],
  linux: [
    { manager: "apt", command: "sudo apt-get install -y python3 python3-pip" },
    { manager: "dnf", command: "sudo dnf install -y python3 python3-pip" },
  ],
};

/**
 * Tools an agent actually reaches for unprompted. Deliberately not exhaustive — an
 * unknown binary still gets the "not installed" verdict and the loop-breaking guidance,
 * just without a canned install command.
 */
const TOOLS: Record<string, ToolSpec> = {
  node: NODE_TOOLCHAIN,
  npm: NODE_TOOLCHAIN,
  npx: NODE_TOOLCHAIN,
  yarn: {
    summary: "Yarn package manager",
    docsUrl: "https://yarnpkg.com/getting-started/install",
    win32: [{ manager: "npm", command: "npm install -g yarn" }],
    darwin: [{ manager: "brew", command: "brew install yarn" }],
    linux: [{ manager: "npm", command: "npm install -g yarn" }],
  },
  pnpm: {
    summary: "pnpm package manager",
    docsUrl: "https://pnpm.io/installation",
    win32: [{ manager: "npm", command: "npm install -g pnpm" }],
    darwin: [{ manager: "brew", command: "brew install pnpm" }],
    linux: [{ manager: "npm", command: "npm install -g pnpm" }],
  },
  bun: {
    summary: "Bun runtime and package manager",
    docsUrl: "https://bun.sh/docs/installation",
    win32: [{ manager: "winget", command: "winget install Oven-sh.Bun" }],
    darwin: [{ manager: "brew", command: "brew install oven-sh/bun/bun" }],
    linux: [{ manager: "script", command: "curl -fsSL https://bun.sh/install | bash" }],
  },
  brew: {
    summary: "Homebrew package manager for macOS and Linux",
    docsUrl: "https://brew.sh",
    // Homebrew does not run on Windows; win32 is deliberately absent so the hint says so.
    darwin: [{ manager: "script", command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' }],
    linux: [{ manager: "script", command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' }],
  },
  git: {
    summary: "Git version control",
    docsUrl: "https://git-scm.com/downloads",
    win32: [{ manager: "winget", command: "winget install Git.Git" }],
    darwin: [{ manager: "brew", command: "brew install git" }],
    linux: [
      { manager: "apt", command: "sudo apt-get install -y git" },
      { manager: "dnf", command: "sudo dnf install -y git" },
    ],
  },
  python: PYTHON_TOOLCHAIN,
  python3: PYTHON_TOOLCHAIN,
  pip: PYTHON_TOOLCHAIN,
  pip3: PYTHON_TOOLCHAIN,
  uv: {
    summary: "uv Python package and project manager",
    docsUrl: "https://docs.astral.sh/uv/getting-started/installation/",
    win32: [{ manager: "winget", command: "winget install astral-sh.uv" }],
    darwin: [{ manager: "brew", command: "brew install uv" }],
    linux: [{ manager: "script", command: "curl -LsSf https://astral.sh/uv/install.sh | sh" }],
  },
  cargo: {
    summary: "Rust toolchain (cargo, rustc)",
    docsUrl: "https://rustup.rs",
    provides: ["cargo", "rustc", "rustup"],
    win32: [{ manager: "winget", command: "winget install Rustlang.Rustup" }],
    darwin: [{ manager: "brew", command: "brew install rustup-init" }],
    linux: [{ manager: "script", command: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" }],
  },
  go: {
    summary: "Go toolchain",
    docsUrl: "https://go.dev/dl/",
    win32: [{ manager: "winget", command: "winget install GoLang.Go" }],
    darwin: [{ manager: "brew", command: "brew install go" }],
    linux: [{ manager: "apt", command: "sudo apt-get install -y golang-go" }],
  },
  docker: {
    summary: "Docker container runtime",
    docsUrl: "https://docs.docker.com/get-docker/",
    win32: [{ manager: "winget", command: "winget install Docker.DockerDesktop" }],
    darwin: [{ manager: "brew", command: "brew install --cask docker" }],
    linux: [{ manager: "script", command: "curl -fsSL https://get.docker.com | sh" }],
  },
  gh: {
    summary: "GitHub CLI",
    docsUrl: "https://cli.github.com",
    win32: [{ manager: "winget", command: "winget install GitHub.cli" }],
    darwin: [{ manager: "brew", command: "brew install gh" }],
    linux: [{ manager: "apt", command: "sudo apt-get install -y gh" }],
  },
  rg: {
    summary: "ripgrep fast recursive search",
    docsUrl: "https://github.com/BurntSushi/ripgrep#installation",
    win32: [{ manager: "winget", command: "winget install BurntSushi.ripgrep.MSVC" }],
    darwin: [{ manager: "brew", command: "brew install ripgrep" }],
    linux: [{ manager: "apt", command: "sudo apt-get install -y ripgrep" }],
  },
  make: {
    summary: "GNU Make build tool",
    docsUrl: "https://www.gnu.org/software/make/",
    win32: [{ manager: "winget", command: "winget install GnuWin32.Make" }],
    darwin: [{ manager: "brew", command: "brew install make" }],
    linux: [{ manager: "apt", command: "sudo apt-get install -y build-essential" }],
  },
  java: {
    summary: "Java Development Kit",
    docsUrl: "https://adoptium.net/temurin/releases/",
    win32: [{ manager: "winget", command: "winget install EclipseAdoptium.Temurin.21.JDK" }],
    darwin: [{ manager: "brew", command: "brew install --cask temurin" }],
    linux: [{ manager: "apt", command: "sudo apt-get install -y default-jdk" }],
  },
  dotnet: {
    summary: ".NET SDK",
    docsUrl: "https://dotnet.microsoft.com/download",
    win32: [{ manager: "winget", command: "winget install Microsoft.DotNet.SDK.8" }],
    darwin: [{ manager: "brew", command: "brew install --cask dotnet-sdk" }],
    linux: [{ manager: "apt", command: "sudo apt-get install -y dotnet-sdk-8.0" }],
  },
};

/**
 * Patterns every shell we can end up under uses to say "no such executable", each
 * capturing the offending name.
 *
 * The name matters: it is what gets installed. It is not always the binary we spawned —
 * on Windows every command is routed through cmd.exe (see planSpawn) and an explicit
 * `bash -lc "npm ci"` spawns bash, so in both cases the process starts fine and the miss
 * is reported *about a nested name*. Capturing it means `npm` gets the hint rather than
 * the shell that reported it.
 *
 * `EACCES` is deliberately not here: the file exists but is not executable, which is a
 * different problem with a different fix.
 */
const MISSING_PATTERNS: RegExp[] = [
  /\bspawn\s+(\S+?)\s+ENOENT\b/i,                                   // node spawn, POSIX direct
  /'([^']+)' is not recognized as an internal or external command/i, // cmd.exe
  /The term '([^']+)' is not recognized/i,                           // PowerShell
  /(?:^|:\s*)([^\s:]+): command not found/im,                        // bash / zsh
  /(?:^|:\s*)([^\s:]+): not found\s*$/im,                            // dash / sh / busybox
];

/**
 * The name of the executable a shell reported as missing, or null if this output is not
 * a missing-command failure.
 *
 * Callers must only consult this for a run that actually failed — a successful build that
 * happens to echo "foo: command not found" from an optional probe is not a missing-command
 * failure, and hijacking it would be worse than the bug this fixes (see handleShell).
 */
export function detectMissingCommand(stderr: string): string | null {
  if (!stderr) return null;
  for (const pattern of MISSING_PATTERNS) {
    const match = pattern.exec(stderr);
    if (match?.[1]) return lookupKey(match[1]);
  }
  return null;
}

/** Normalizes the spawned name to a lookup key: drops any directory part and the
 *  Windows shim/extension suffix, so "npx.cmd" and "C:\\path\\node.exe" both resolve. */
function lookupKey(command: string): string {
  const base = command.trim().replace(/\\/g, "/").split("/").pop() ?? command.trim();
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
}

/**
 * Install guidance for a missing executable on the given platform.
 *
 * Always returns a hint — an unrecognized tool still gets one, with no options, because
 * "this is not installed" is the load-bearing part and is true regardless of whether we
 * know how to install it.
 */
export function installHintFor(command: string, platform: NodeJS.Platform = process.platform): InstallHint {
  const key = lookupKey(command);
  const spec = TOOLS[key];
  if (!spec) {
    return { command: key, summary: `\`${key}\` is not on this machine's PATH`, options: [] };
  }
  const options = platform === "win32" ? spec.win32
    : platform === "darwin" ? spec.darwin
      : spec.linux;
  return {
    command: key,
    summary: spec.summary,
    options: options ?? [],
    docsUrl: spec.docsUrl,
    provides: spec.provides,
  };
}

/**
 * The error text handed back to the model for a missing executable.
 *
 * Written to end the retry loop in one turn: it states plainly that re-running will not
 * help, gives the user-facing install path, and points the agent at the two moves that
 * *can* make progress (use an installed alternative, or ask the user). Without the
 * explicit "do not retry" the model reliably tries the same command again with trivial
 * variations.
 */
export function describeMissingCommand(hint: InstallHint): string {
  const lines = [
    `\`${hint.command}\` is not installed on this machine (not found on PATH), so the command did not run.`,
    "Re-running it, or retrying with different arguments, will fail the same way until it is installed.",
  ];
  if (hint.options.length) {
    lines.push(
      `The user has been offered a one-click install in the editor. It can also be installed with: ${
        hint.options.map((o) => `\`${o.command}\``).join(" or ")}.`,
    );
  } else if (hint.docsUrl) {
    lines.push(`Install instructions: ${hint.docsUrl}`);
  }
  lines.push(
    "Do not call this command again in this turn. Either continue with a tool that is installed, "
    + "or stop and tell the user what to install and why you need it.",
  );
  return lines.join(" ");
}
