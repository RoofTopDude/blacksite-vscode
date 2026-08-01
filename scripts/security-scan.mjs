#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(resolve(root, "security/policy.json"), "utf8"));
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".pdf", ".zip", ".vsix", ".xlsx",
]);
const SKIPPED_PATHS = new Set(["scripts/security-scan.mjs"]);

const secretRules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["openai-anthropic-key", /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ["stripe-live-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
  ["twilio-key", /\bSK[a-f0-9]{32}\b/gi],
  ["credentialed-url", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/[A-Za-z0-9._~%+-]+:[A-Za-z0-9._~%+/=!-]+@/gi],
  ["generic-secret", /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']([A-Za-z0-9+/_=-]{20,})["']/gi],
];
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|internal)\b/gi;
const labelledPhonePattern = /\b(?:phone|telephone|mobile|contact)\s*[:=]\s*\+?[0-9][0-9 ()-]{7,}[0-9]/gi;

function repositoryFiles() {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return output.split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function annotation(level, file, line, title, message) {
  const safe = message.replace(/[\r\n%]/g, (character) => ({ "\r": "%0D", "\n": "%0A", "%": "%25" })[character]);
  console[level === "error" ? "error" : "warn"](`::${level} file=${file},line=${line},title=${title}::${safe}`);
}

function allowedEmail(email, file) {
  const domain = email.toLowerCase().split("@").pop();
  if ((policy.pii?.ignoredEmailDomains ?? []).some((entry) => {
    const ignored = String(entry).toLowerCase();
    return domain === ignored || domain.endsWith(`.${ignored}`);
  })) return true;
  return (policy.pii?.allowedEmails ?? []).some((entry) =>
    String(entry.value).toLowerCase() === email.toLowerCase()
      && (entry.paths ?? []).map((item) => String(item).replace(/\\/g, "/")).includes(file));
}

const findings = [];
const files = repositoryFiles();
for (const file of files) {
  if (SKIPPED_PATHS.has(file) || BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
  let bytes;
  try { bytes = readFileSync(resolve(root, file)); } catch { continue; }
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) continue;
  const text = bytes.toString("utf8");

  for (const [rule, pattern] of secretRules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, line: lineAt(text, match.index ?? 0), rule, message: "Possible committed secret; rotate it if it is real, then remove it from source and history." });
    }
  }

  emailPattern.lastIndex = 0;
  for (const match of text.matchAll(emailPattern)) {
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1);
    if (match[0].toLowerCase() === "git@github.com" && after === ":") continue;
    if (!allowedEmail(match[0], file)) {
      findings.push({ file, line: lineAt(text, match.index ?? 0), rule: "unapproved-contact-email", message: "Contact email is not an approved licensing address/path in security/policy.json." });
    }
  }

  if (/\.(?:md|html?)$/i.test(file)) {
    labelledPhonePattern.lastIndex = 0;
    for (const match of text.matchAll(labelledPhonePattern)) {
      findings.push({ file, line: lineAt(text, match.index ?? 0), rule: "contact-phone", message: "Possible public contact phone number requires explicit policy review." });
    }
  }

  if (/\.(?:[cm]?[jt]s|tsx)$/i.test(file)) {
    for (const match of text.matchAll(/\bshell\s*:\s*true\b/g)) {
      const sourceLine = text.slice(text.lastIndexOf("\n", match.index ?? 0) + 1, text.indexOf("\n", match.index ?? 0) === -1 ? text.length : text.indexOf("\n", match.index ?? 0));
      if (/^\s*(?:\/\/|\*)/.test(sourceLine) || sourceLine.includes("security-scan: allow-shell")) continue;
      findings.push({ file, line: lineAt(text, match.index ?? 0), rule: "shell-execution", message: "Shell-enabled process execution can reinterpret arguments; use direct executable arguments instead." });
    }
  }
}

for (const file of files.filter((entry) => /^\.github\/workflows\/.*\.ya?ml$/i.test(entry))) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    if (!/@[a-f0-9]{40}$/i.test(reference)) {
      findings.push({ file, line: lineAt(text, match.index ?? 0), rule: "unpinned-action", message: "GitHub Action references must use a full 40-character commit SHA." });
    }
  }
}

const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (manifest.capabilities?.untrustedWorkspaces?.supported !== false) {
  findings.push({ file: "package.json", line: 1, rule: "workspace-trust", message: "This code-executing extension must be disabled in untrusted workspaces." });
}
if (manifest.contributes?.configuration?.properties?.["blacksite.mcpServers"]?.scope !== "application") {
  findings.push({ file: "package.json", line: 1, rule: "mcp-settings-scope", message: "MCP process and network destinations must not be configurable by repository settings." });
}
const toolDefinitions = readFileSync(resolve(root, "src/tools/definitions.ts"), "utf8");
const mcpDefinitions = toolDefinitions.slice(toolDefinitions.indexOf('"mcp_list_tools"'), toolDefinitions.indexOf("export const DIAGNOSTICS_TOOLS"));
if (!/serverId:\s*str\(/.test(mcpDefinitions) || /\b(?:apiKey|headers):/.test(mcpDefinitions) || /server:\s*obj\(/.test(mcpDefinitions)) {
  findings.push({ file: "src/tools/definitions.ts", line: 1, rule: "mcp-model-destination", message: "MCP model schemas must accept only configured server IDs, never raw destinations or credentials." });
}
const updateService = readFileSync(resolve(root, "src/update-service.ts"), "utf8");
if (!/verifyVsixBytes/.test(updateService) || !/sha256:/i.test(updateService)) {
  findings.push({ file: "src/update-service.ts", line: 1, rule: "update-integrity", message: "Self-update downloads must remain SHA-256 verified before installation." });
}
const bridge = readFileSync(resolve(root, "src/browser-bridge.ts"), "utf8");
if (!/isBridgeRequestAuthorized/.test(bridge) || !/authorization/i.test(bridge)) {
  findings.push({ file: "src/browser-bridge.ts", line: 1, rule: "bridge-auth", message: "The localhost browser bridge must authenticate every control-plane request." });
}
const mcpPanel = readFileSync(resolve(root, "src/mcp-panel.ts"), "utf8");
if (/script-src[^;]*'unsafe-inline'/i.test(mcpPanel) || /fonts\.googleapis\.com/i.test(mcpPanel) || /\son[a-z]+=/i.test(mcpPanel)) {
  findings.push({ file: "src/mcp-panel.ts", line: 1, rule: "mcp-webview-csp", message: "The MCP webview must use a nonce, avoid inline event handlers, and load no remote assets." });
}
const shell = readFileSync(resolve(root, "src/webview/shell.html"), "utf8");
if (/img-src[^;]*https:/i.test(shell) || !/base-uri\s+'none'/i.test(shell) || !/form-action\s+'none'/i.test(shell)) {
  findings.push({ file: "src/webview/shell.html", line: 1, rule: "webview-csp", message: "Webview CSP must block remote images, base navigation, and form submission." });
}

for (const finding of findings) annotation("error", finding.file, finding.line, finding.rule, finding.message);
console.log(`Static security scan: ${files.length} repository file(s), ${findings.length} finding(s).`);
if (findings.length > 0) process.exitCode = 1;
