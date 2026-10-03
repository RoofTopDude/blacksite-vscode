/* The setup script the user watches run: a preview of every step, a prompt that only a typed "Y"
   gets past, then each step with a numbered header and every command echoed before it runs.

   ── Why a script in a terminal ───────────────────────────────────────────────
   Installing toolchains changes the user's machine, sometimes with administrator rights. Running it
   in a visible terminal — not in the background — keeps the user in the loop: they see the whole
   plan before anything happens, they start it themselves, and they watch every command and its
   output. Typing anything other than Y leaves the machine exactly as it was.

   ── Failure handling ────────────────────────────────────────────────────────
   A prerequisite or system step that fails stops the run: everything after it depends on it. A
   project step that fails is reported and the next project carries on — one broken lockfile should
   not cost the user the other nineteen projects. Each step's exit code goes into a result file the
   extension reads when the script finishes.

   Every value comes from recipes.ts; paths are single-quoted for the target shell. Pure. */

import { quoteFor, type InstallStep, type Platform, type ScriptCommand } from "./recipes.js";

export interface ScriptOptions {
  platform: Platform;
  /** Where the script writes `{ declined, steps: [{ id, exitCode }] }` when it ends. */
  resultPath: string;
  /** Downloaded archives are kept here and reused when their checksum still matches. */
  cacheDir: string;
}

const ELEVATION_NOTE = {
  none: "",
  admin: "Windows asks for administrator permission",
  sudo: "asks for your password (sudo)",
} as const;

function previewLines(steps: readonly InstallStep[]): string[] {
  const lines: string[] = [];
  const phases: Array<[InstallStep["phase"], string]> = [
    ["prerequisite", "First, tools the other steps need"],
    ["system", "Install for this machine"],
    ["project", "Inside projects"],
    ["dependencies", "Project dependencies"],
  ];
  let number = 0;
  for (const [phase, heading] of phases) {
    const inPhase = steps.filter((step) => step.phase === phase);
    if (inPhase.length === 0) continue;
    lines.push("", heading);
    for (const step of inPhase) {
      number += 1;
      lines.push(`  ${number}. ${step.project ? `${step.project}: ` : ""}${step.title}`);
      lines.push(`     where: ${step.target}`);
      if (step.elevation !== "none") lines.push(`     note:  ${ELEVATION_NOTE[step.elevation]}`);
      for (const command of step.commands) lines.push(`     $ ${describeCommand(command)}`);
      lines.push(`     undo:  ${step.undo}`);
    }
  }
  return lines;
}

/** A command as the preview shows it. */
export function describeCommand(command: ScriptCommand): string {
  switch (command.kind) {
    case "run": return `${command.cwd ? `(in ${command.cwd}) ` : ""}${command.argv.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
    case "shell": return command.script;
    case "download": return `download ${command.url}, check SHA-256 ${command.sha256.slice(0, 12)}…, unpack into ${command.into}`;
    case "append": return `add "${command.line}" to ${command.file}`;
  }
}

/* ── PowerShell ─────────────────────────────────────────────────────────── */

function ps(value: string): string {
  return quoteFor("win32", value);
}

function powershellCommand(command: ScriptCommand): string[] {
  switch (command.kind) {
    case "run": {
      const [program, ...args] = command.argv;
      const call = `& ${ps(program!)} ${args.map(ps).join(" ")}`.trimEnd();
      const body = [`Write-Host ${ps(`> ${describeCommand(command)}`)} -ForegroundColor DarkGray`];
      if (command.cwd) body.push(`Push-Location -LiteralPath ${ps(command.cwd)}`);
      body.push(`$global:LASTEXITCODE = 0`, call, `$rc = if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 }`);
      if (command.cwd) body.push("Pop-Location");
      body.push("if ($rc -ne 0) { throw \"exit code $rc\" }");
      return body;
    }
    case "shell":
      return [
        `Write-Host ${ps(`> ${command.script}`)} -ForegroundColor DarkGray`,
        "$global:LASTEXITCODE = 0",
        command.script,
        "if ($LASTEXITCODE) { throw \"exit code $LASTEXITCODE\" }",
      ];
    case "download":
      return [
        `Write-Host ${ps(`> ${describeCommand(command)}`)} -ForegroundColor DarkGray`,
        `$archive = Join-Path $cacheDir ${ps(command.fileName)}`,
        `$expected = ${ps(command.sha256)}`,
        "if (-not ((Test-Path -LiteralPath $archive) -and ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -eq $expected))) {",
        `  Invoke-WebRequest -UseBasicParsing -Uri ${ps(command.url)} -OutFile $archive`,
        "}",
        "$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()",
        "if ($actual -ne $expected) { Remove-Item -LiteralPath $archive -Force; throw \"checksum mismatch: expected $expected, got $actual\" }",
        "Write-Host '  checksum OK' -ForegroundColor DarkGreen",
        `New-Item -ItemType Directory -Force -Path ${ps(command.into)} | Out-Null`,
        `Expand-Archive -LiteralPath $archive -DestinationPath ${ps(command.into)} -Force`,
      ];
    case "append":
      return [
        `Write-Host ${ps(`> ${describeCommand(command)}`)} -ForegroundColor DarkGray`,
        `Add-Content -LiteralPath ${ps(command.file)} -Value ${ps(command.line)}`,
      ];
  }
}

function powershellScript(steps: readonly InstallStep[], options: ScriptOptions): string {
  const preview = previewLines(steps);
  const out: string[] = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$resultPath = ${ps(options.resultPath)}`,
    `$cacheDir = ${ps(options.cacheDir)}`,
    "New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null",
    "function Write-Result($declined, $results) {",
    "  $payload = @{ declined = $declined; finished = $true; steps = @($results) }",
    "  ConvertTo-Json -InputObject $payload -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding UTF8",
    "}",
    "Write-Host ''",
    "Write-Host '==================== Blacksite: toolchain setup ====================' -ForegroundColor Cyan",
    ...preview.map((line) => `Write-Host ${ps(line)}`),
    "Write-Host ''",
    "Write-Host '=====================================================================' -ForegroundColor Cyan",
    "$answer = Read-Host 'Proceed? Type Y to start, anything else to cancel'",
    "if ($answer -ne 'Y' -and $answer -ne 'y') {",
    "  Write-Result $true @()",
    "  Write-Host 'Cancelled, nothing was changed.' -ForegroundColor Yellow",
    "  Read-Host 'Press Enter to close' | Out-Null",
    "  exit 0",
    "}",
    "$results = @()",
    "$stopped = $false",
  ];
  steps.forEach((step, index) => {
    const header = `[${index + 1}/${steps.length}] ${step.project ? `${step.project}: ` : ""}${step.title}`;
    out.push(
      "",
      "if ($stopped) {",
      `  $results += @{ id = ${ps(step.id)}; exitCode = -1; skipped = $true }`,
      "} else {",
      "  Write-Host ''",
      `  Write-Host ${ps(header)} -ForegroundColor Cyan`,
      "  $code = 0; $rc = 0",
      "  try {",
      ...step.commands.flatMap(powershellCommand).map((line) => `    ${line}`),
      "  } catch {",
      "    $code = if ($rc) { $rc } else { 1 }",
      "    Write-Host \"  failed: $($_.Exception.Message)\" -ForegroundColor Red",
      "  }",
      `  $results += @{ id = ${ps(step.id)}; exitCode = $code }`,
      ...(step.critical ? ["  if ($code -ne 0) { $stopped = $true; Write-Host '  This step is needed by the ones after it, so the setup stops here.' -ForegroundColor Red }"] : []),
      "}",
    );
  });
  out.push(
    "",
    "Write-Result $false $results",
    "Write-Host ''",
    "$failed = @($results | Where-Object { $_.exitCode -ne 0 }).Count",
    "if ($failed -eq 0) { Write-Host 'Setup finished. Every step succeeded.' -ForegroundColor Green }",
    "else { Write-Host \"Setup finished with $failed step(s) that did not complete. Blacksite shows which.\" -ForegroundColor Yellow }",
    "Write-Host 'New terminals see the updated PATH; Blacksite rescans automatically.'",
    "Read-Host 'Press Enter to close' | Out-Null",
  );
  return out.join("\r\n") + "\r\n";
}

/* ── POSIX shell ────────────────────────────────────────────────────────── */

function sh(value: string): string {
  return quoteFor("linux", value);
}

function shellCommand(command: ScriptCommand): string[] {
  switch (command.kind) {
    case "run":
      return [
        `printf '\\033[2m%s\\033[0m\\n' ${sh(`> ${describeCommand(command)}`)}`,
        `${command.cwd ? `(cd ${sh(command.cwd)} && ` : ""}${command.argv.map(sh).join(" ")}${command.cwd ? ")" : ""} || return 1`,
      ];
    case "shell":
      return [`printf '\\033[2m%s\\033[0m\\n' ${sh(`> ${command.script}`)}`, `${command.script} || return 1`];
    case "download":
      return [
        `printf '\\033[2m%s\\033[0m\\n' ${sh(`> ${describeCommand(command)}`)}`,
        `archive="$cache_dir"/${sh(command.fileName)}`,
        `expected=${sh(command.sha256)}`,
        "if [ ! -f \"$archive\" ] || [ \"$(sha256_of \"$archive\")\" != \"$expected\" ]; then",
        `  curl -fL --proto '=https' --tlsv1.2 -o "$archive" ${sh(command.url)} || return 1`,
        "fi",
        "actual=\"$(sha256_of \"$archive\")\"",
        "if [ \"$actual\" != \"$expected\" ]; then rm -f \"$archive\"; echo \"  checksum mismatch: expected $expected, got $actual\"; return 1; fi",
        "echo '  checksum OK'",
        `mkdir -p ${sh(command.into)} || return 1`,
        `tar -xf "$archive" -C ${sh(command.into)} || return 1`,
      ];
    case "append":
      return [
        `printf '\\033[2m%s\\033[0m\\n' ${sh(`> ${describeCommand(command)}`)}`,
        `printf '%s\\n' ${sh(command.line)} >> ${sh(command.file)} || return 1`,
      ];
  }
}

function posixScript(steps: readonly InstallStep[], options: ScriptOptions): string {
  const preview = previewLines(steps);
  const out: string[] = [
    "#!/usr/bin/env bash",
    `result_path=${sh(options.resultPath)}`,
    `cache_dir=${sh(options.cacheDir)}`,
    "mkdir -p \"$cache_dir\"",
    "sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | cut -d' ' -f1; else shasum -a 256 \"$1\" | cut -d' ' -f1; fi; }",
    "results=''",
    "add_result() { results=\"$results${results:+,}{\\\"id\\\":\\\"$1\\\",\\\"exitCode\\\":$2}\"; }",
    "write_result() { printf '{\"declined\":%s,\"finished\":true,\"steps\":[%s]}\\n' \"$1\" \"$results\" > \"$result_path\"; }",
    "printf '\\n\\033[36m==================== Blacksite: toolchain setup ====================\\033[0m\\n'",
    ...preview.map((line) => `printf '%s\\n' ${sh(line)}`),
    "printf '\\n\\033[36m=====================================================================\\033[0m\\n'",
    "printf 'Proceed? Type Y to start, anything else to cancel: '",
    "read -r answer",
    "if [ \"$answer\" != \"Y\" ] && [ \"$answer\" != \"y\" ]; then",
    "  write_result true",
    "  printf '\\033[33mCancelled, nothing was changed.\\033[0m\\n'",
    "  printf 'Press Enter to close'; read -r _",
    "  exit 0",
    "fi",
    "stopped=0",
  ];
  steps.forEach((step, index) => {
    const header = `[${index + 1}/${steps.length}] ${step.project ? `${step.project}: ` : ""}${step.title}`;
    const fn = `step_${index + 1}`;
    out.push(
      "",
      `${fn}() {`,
      ...step.commands.flatMap(shellCommand).map((line) => `  ${line}`),
      "}",
      "if [ \"$stopped\" = 1 ]; then",
      `  add_result ${sh(step.id)} -1`,
      "else",
      `  printf '\\n\\033[36m%s\\033[0m\\n' ${sh(header)}`,
      `  if ${fn}; then add_result ${sh(step.id)} 0; else`,
      "    printf '\\033[31m  failed\\033[0m\\n'",
      `    add_result ${sh(step.id)} 1`,
      ...(step.critical ? ["    stopped=1; printf '\\033[31m  This step is needed by the ones after it, so the setup stops here.\\033[0m\\n'"] : []),
      "  fi",
      "fi",
    );
  });
  out.push(
    "",
    "write_result false",
    "printf '\\nSetup finished. Blacksite shows the result of each step and rescans automatically.\\n'",
    "printf 'New terminals see the updated PATH.\\n'",
    "printf 'Press Enter to close'; read -r _",
  );
  return out.join("\n") + "\n";
}

/** The script for the user's shell: PowerShell on Windows, bash elsewhere. */
export function buildInstallScript(steps: readonly InstallStep[], options: ScriptOptions): string {
  return options.platform === "win32" ? powershellScript(steps, options) : posixScript(steps, options);
}

export interface InstallResult {
  declined: boolean;
  finished: boolean;
  steps: Array<{ id: string; exitCode: number; skipped?: boolean }>;
}

export function parseInstallResult(text: string): InstallResult | undefined {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, "")) as Partial<InstallResult>;
    if (typeof value.declined !== "boolean") return undefined;
    return { declined: value.declined, finished: value.finished === true, steps: Array.isArray(value.steps) ? value.steps.filter((step) => step && typeof step.id === "string") : [] };
  } catch {
    return undefined;
  }
}
