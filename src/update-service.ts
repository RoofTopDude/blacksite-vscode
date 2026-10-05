import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const LAST_CHECK_KEY = "blacksite.updates.lastCheckAt";
const DISMISSED_VERSION_KEY = "blacksite.updates.dismissedVersion";

/** How often a live window re-checks for a release. See {@link ExtensionUpdater.scheduleUpdateChecks}. */
export const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;

/**
 * Floor on elapsed time before a check actually runs — deliberately a little *under*
 * {@link UPDATE_CHECK_INTERVAL_MS} rather than equal to it.
 *
 * `lastCheckAt` is stamped when a check *finishes*, so a timer firing exactly one interval after
 * the previous tick began measures marginally less than one interval and would be turned away by
 * the very throttle its own predecessor set — silently halving the real cadence to six hours, on
 * a schedule too slow to notice in testing. The margin absorbs that plus ordinary timer drift,
 * while still being long enough to keep a burst of window reloads from each firing a check.
 */
const UPDATE_CHECK_MIN_ELAPSED_MS = UPDATE_CHECK_INTERVAL_MS - 5 * 60 * 1000;
/**
 * How soon an automatic check that failed (rate limit, offline, a proxy) is tried again. Waiting a
 * full interval after a failure is how a prerelease user — whose only source is the rate-limited
 * GitHub API — could go days without being offered a release, with nothing on screen to say why.
 */
export const FAILED_CHECK_RETRY_MS = 30 * 60 * 1000;
const RELEASES_PAGE_SIZE = 10;
const API_TIMEOUT_MS = 15_000;
/**
 * Budget for the VSIX itself, separate from {@link API_TIMEOUT_MS}. The timeout signal covers the
 * whole body read, not just the response headers, and the package is ~15 MB — so the API's 15s
 * failed every "Update Now" on a link slower than about 8 Mbit/s with a bare "operation was
 * aborted". Five minutes still bounds a stalled transfer.
 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_VSIX_BYTES = 100 * 1024 * 1024;
const SHA256_DIGEST_RE = /^sha256:([a-f0-9]{64})$/i;
const UPDATE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Release manifest published alongside the site by .github/workflows/pages.yml, derived
 * from the newest published GitHub release.
 *
 * This is the primary source rather than the GitHub API for two reasons: it is one static
 * request against a CDN instead of a call into api.github.com's 60-requests-per-hour-per-IP
 * unauthenticated budget (which one office behind a single NAT exhausts), and it needs no
 * credentials at all. The GitHub API stays as a fallback for when the site is unreachable
 * and as the only source that can see prereleases, which the manifest does not carry.
 *
 * Deliberately the Pages origin rather than the marketing domain in package.json's `homepage`.
 * That domain does not currently resolve to Pages, and its host answers *every* path with a
 * 200 and an HTML parking page — which is worse than a 404 here, because `response.ok` passes
 * and only the JSON parse fails. Point this at the custom domain once it actually serves Pages.
 */
const DEFAULT_MANIFEST_URL = "https://rooftopdude.github.io/blacksite-vscode/latest.json";

interface ReleaseManifest {
  version?: unknown;
  downloadUrl?: unknown;
  fileName?: unknown;
  releaseUrl?: unknown;
  name?: unknown;
  digest?: unknown;
  size?: unknown;
  /** The release's `engines.vscode` range, published by pages.yml from package.json. */
  minimumVscodeVersion?: unknown;
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  url?: string;
  digest?: string;
  size?: number;
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubReleaseAsset[];
}

interface UpdateInfo {
  /** Where this answer came from, for the update log. */
  source?: "manifest" | "github";
  version: string;
  asset: GithubReleaseAsset;
  releaseUrl: string;
  releaseTitle: string;
  /** `engines.vscode` of the release when the source publishes it (the manifest does; the
      GitHub API does not, so the downloaded VSIX is checked as well — see readVsixEngineRange). */
  minimumVscodeVersion?: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type VsixInstaller = (vsixPath: string) => Promise<void>;
/** One line per update check, written to the "Blacksite Updates" output channel. */
type UpdateLog = (line: string) => void;

export function validateReleaseAssetMetadata(asset: GithubReleaseAsset, version: string): string {
  if (!UPDATE_VERSION_RE.test(version)) throw new Error("The update has an invalid version.");
  const digestMatch = SHA256_DIGEST_RE.exec(asset.digest ?? "");
  if (!digestMatch?.[1]) throw new Error("The release asset does not publish a SHA-256 digest.");
  let downloadUrl: URL;
  try { downloadUrl = new URL(asset.browser_download_url); }
  catch { throw new Error("The release asset has an invalid download URL."); }
  if (downloadUrl.protocol !== "https:" || downloadUrl.hostname.toLowerCase() !== "github.com") {
    throw new Error("Release assets must be downloaded from github.com over HTTPS.");
  }
  if (typeof asset.size === "number" && asset.size > MAX_VSIX_BYTES) {
    throw new Error(`The release asset exceeds the ${MAX_VSIX_BYTES}-byte safety limit.`);
  }
  return digestMatch[1].toLowerCase();
}

export function verifyVsixBytes(bytes: Buffer, expectedHash: string): void {
  if (bytes.length > MAX_VSIX_BYTES) {
    throw new Error(`The downloaded VSIX exceeds the ${MAX_VSIX_BYTES}-byte safety limit.`);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error("The downloaded VSIX failed SHA-256 verification.");
  }
}

interface ExtensionPackageInfo {
  name?: string;
  version?: string;
  repository?: unknown;
}

function getUpdateConfig(): { checkOnStartup: boolean; includePrerelease: boolean; repository: string; manifestUrl: string } {
  const cfg = vscode.workspace.getConfiguration("blacksite");
  // Where updates come from is read from user settings only. A merged read also takes a
  // repository's `.vscode/settings.json`, which let any trusted workspace point the updater at
  // its own manifest or GitHub repo and offer its VSIX as a genuine "Blacksite update" — the
  // digest check proves the bytes match what that source published, not who published them.
  // (package.json marks these "scope": "application"; reading globalValue enforces it here too.)
  const userValue = <T>(key: string): T | undefined => cfg.inspect<T>(key)?.globalValue;
  return {
    checkOnStartup: cfg.get<boolean>("updates.checkOnStartup", true),
    includePrerelease: userValue<boolean>("updates.includePrerelease") === true,
    repository: String(userValue<string>("updates.repository") ?? "").trim(),
    manifestUrl: String(userValue<string>("updates.manifestUrl") ?? "").trim() || DEFAULT_MANIFEST_URL,
  };
}

/**
 * Read the published release manifest.
 *
 * Returns null rather than throwing for any shape problem — a stale or placeholder manifest
 * (CI writes `{"version": null}` before the first release) is a normal state, not an error,
 * and must fall through to the GitHub API rather than surfacing a failure to the user.
 */
export function parseReleaseManifest(payload: unknown, extensionPackageName = ""): UpdateInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const manifest = payload as ReleaseManifest;
  const downloadUrl = typeof manifest.downloadUrl === "string" ? manifest.downloadUrl : "";
  const rawVersion = typeof manifest.version === "string" ? manifest.version : "";
  if (!downloadUrl || !rawVersion) return null;
  const version = rawVersion.replace(/^v/, "");
  if (!UPDATE_VERSION_RE.test(version)) return null;
  const digest = typeof manifest.digest === "string" && SHA256_DIGEST_RE.test(manifest.digest)
    ? manifest.digest.toLowerCase()
    : "";
  // A manifest is an optimization over the GitHub API, not a reason to install unsigned bytes.
  // Older manifests fall back to the API, whose release asset includes the digest.
  if (!digest) return null;

  const fileName = typeof manifest.fileName === "string" && manifest.fileName
    ? manifest.fileName
    : `${extensionPackageName || "blacksite-vscode"}-${version}.vsix`;

  return {
    version,
    asset: {
      name: fileName,
      browser_download_url: downloadUrl,
      digest,
      ...(typeof manifest.size === "number" && Number.isSafeInteger(manifest.size) ? { size: manifest.size } : {}),
    },
    source: "manifest",
    releaseUrl: typeof manifest.releaseUrl === "string" && manifest.releaseUrl ? manifest.releaseUrl : DEFAULT_MANIFEST_URL,
    releaseTitle: typeof manifest.name === "string" && manifest.name ? manifest.name : `Blacksite ${rawVersion}`,
    ...(typeof manifest.minimumVscodeVersion === "string" && manifest.minimumVscodeVersion.trim()
      ? { minimumVscodeVersion: manifest.minimumVscodeVersion.trim() }
      : {}),
  };
}

/**
 * Whether the running VS Code satisfies a release's `engines.vscode` range.
 *
 * Only the shapes this project publishes are understood: `^x.y.z`, `>=x.y.z`, and a bare
 * `x.y.z` (all meaning "at least"). Anything else — a malformed manifest, a range syntax we
 * do not parse — counts as satisfied: the gate exists to spare users an install that VS Code
 * will refuse, and a parsing gap must never be the reason nobody can update.
 */
export function engineSatisfied(range: string | undefined, running: string): boolean {
  if (!range) return true;
  const match = /^\s*(?:\^|>=\s*)?v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(range);
  if (!match) return true;
  const minimum = `${match[1]}.${match[2]}.${match[3]}`;
  // VS Code reports its own version without a prerelease tag ("1.139.1"); Insiders reports
  // "1.140.0-insider". Compare cores only, so an Insiders build of the required minor passes.
  const core = running.trim().split(/[-+]/, 1)[0] ?? running;
  return compareVersions(core, minimum) >= 0;
}

/** Human form of an engine range for messages: "^1.139.0" → "1.139.0". */
export function engineFloorLabel(range: string): string {
  return range.trim().replace(/^(?:\^|>=\s*)v?/, "");
}

/**
 * Read `engines.vscode` out of a VSIX (a zip whose manifest is `extension/package.json`).
 * Returns null when the archive or manifest is unreadable — the digest already proved the
 * bytes are what the release published, so a manifest we cannot parse is left for VS Code's
 * own installer to judge rather than blocking here.
 */
export function readVsixEngineRange(bytes: Uint8Array): string | null {
  try {
    const files = unzipSync(bytes, { filter: (file) => file.name === "extension/package.json" });
    const manifest = files["extension/package.json"];
    if (!manifest) return null;
    const parsed = JSON.parse(Buffer.from(manifest).toString("utf8")) as { engines?: { vscode?: unknown } };
    const range = parsed.engines?.vscode;
    return typeof range === "string" && range.trim() ? range.trim() : null;
  } catch {
    return null;
  }
}

export function normalizeGithubRepositorySlug(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const bare = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (bare) return `${bare[1]}/${bare[2]}`;

  const cleaned = trimmed.replace(/^git\+/, "");
  const https = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (https) return `${https[1]}/${https[2]}`;

  const ssh = cleaned.match(/^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;

  return null;
}

function extractRepositoryString(repository: unknown): string {
  if (typeof repository === "string") return repository;
  if (!repository || typeof repository !== "object") return "";
  const value = repository as { url?: unknown };
  return typeof value.url === "string" ? value.url : "";
}

export function extractVersionFromVsixName(assetName: string, extensionPackageName = ""): string | null {
  const escapedPrefix = extensionPackageName ? escapeRegExp(`${extensionPackageName}-`) : "";
  const prefixed = escapedPrefix
    ? new RegExp(`${escapedPrefix}(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\.vsix$`, "i")
    : null;
  const prefixedMatch = prefixed ? assetName.match(prefixed) : null;
  if (prefixedMatch?.[1]) return prefixedMatch[1];

  const genericMatch = assetName.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.vsix$/i);
  return genericMatch?.[1] ?? null;
}

function extractReleaseVersion(release: GithubRelease, asset: GithubReleaseAsset | null, extensionPackageName: string): string | null {
  const assetVersion = asset ? extractVersionFromVsixName(asset.name, extensionPackageName) : null;
  if (assetVersion) return assetVersion;

  const text = `${release.tag_name} ${release.name ?? ""}`;
  const genericMatch = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return genericMatch?.[1] ?? null;
}

export function selectVsixAsset(assets: GithubReleaseAsset[], extensionPackageName = ""): GithubReleaseAsset | null {
  const vsixAssets = assets.filter((asset) => /\.vsix$/i.test(asset.name));
  if (vsixAssets.length === 0) return null;
  if (vsixAssets.length === 1) return vsixAssets[0] ?? null;

  const preferredAssets = extensionPackageName
    ? vsixAssets.filter((asset) => asset.name.toLowerCase().startsWith(`${extensionPackageName.toLowerCase()}-`))
    : vsixAssets;
  const candidateAssets = preferredAssets.length > 0 ? preferredAssets : vsixAssets;

  const newest = candidateAssets
    .map((asset) => ({
      asset,
      version: extractVersionFromVsixName(asset.name, extensionPackageName),
    }))
    .filter((entry): entry is { asset: GithubReleaseAsset; version: string } => !!entry.version)
    .sort((left, right) => compareVersions(right.version, left.version))[0];
  if (newest) return newest.asset;

  return candidateAssets[0] ?? null;
}

interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string>;
}

function parseVersion(version: string): ParsedVersion | null {
  const normalized = version.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  // Split on the FIRST hyphen only. `String.split("-", 2)` would discard everything
  // after the second hyphen, truncating a prerelease that itself contains hyphens
  // (semver permits them, e.g. "1.2.3-beta-2" or "1.0.0-x-7-z.92") and making two
  // distinct prereleases compare as equal.
  const firstDash = normalized.indexOf("-");
  const corePartRaw = firstDash === -1 ? normalized : normalized.slice(0, firstDash);
  const prereleasePart = firstDash === -1 ? undefined : normalized.slice(firstDash + 1);
  const corePart = corePartRaw ?? normalized;
  const coreSegments = corePart.split(".").map((segment) => Number.parseInt(segment, 10));
  if (coreSegments.length === 0 || coreSegments.some((segment) => Number.isNaN(segment))) return null;
  const prerelease = prereleasePart
    ? prereleasePart.split(".").map((segment) => (/^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment))
    : [];
  return { core: coreSegments, prerelease };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

  const length = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart > rightPart ? 1 : -1;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart, undefined, { numeric: true, sensitivity: "base" });
  }

  return 0;
}

function resolveRepositorySlug(configuredRepository: string, extensionPackage: ExtensionPackageInfo): string | null {
  if (configuredRepository) return normalizeGithubRepositorySlug(configuredRepository);
  return normalizeGithubRepositorySlug(extractRepositoryString(extensionPackage.repository));
}

function buildGitHubApiUrl(repositorySlug: string): string {
  return `https://api.github.com/repos/${repositorySlug}/releases?per_page=${RELEASES_PAGE_SIZE}`;
}

/** Releases are public, so no credentials are sent — see DEFAULT_MANIFEST_URL. */
function buildGitHubHeaders(accept: string): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": "blacksite-vscode-updater",
  };
}

export function describeGitHubHttpError(status: number, statusText: string, repositorySlug: string): string {
  if (status === 403 || status === 429) {
    return `GitHub returned ${status} ${statusText}. This is normally the unauthenticated API rate limit (60 requests per hour per IP) rather than a permissions problem; the check will succeed again later.`;
  }
  if (status === 404) {
    return `GitHub returned 404 ${statusText}. ${repositorySlug} was not found — check blacksite.updates.repository.`;
  }
  return `GitHub returned ${status} ${statusText}.`;
}

function buildCliCommandCandidates(): string[] {
  const baseName = /insider/i.test(vscode.env.appName) ? "code-insiders" : "code";
  const appRoot = vscode.env.appRoot;
  const windowsExecutable = /insider/i.test(vscode.env.appName) ? "Code - Insiders.exe" : "Code.exe";

  const candidates = new Set<string>([
    ...(process.platform === "win32" ? [
      path.resolve(appRoot, "..", "..", windowsExecutable),
      process.execPath,
    ] : []),
    path.resolve(appRoot, "bin", baseName),
    path.resolve(appRoot, "..", "..", "bin", baseName),
    path.resolve(appRoot, "..", "..", "..", "bin", `${baseName}.cmd`),
    path.resolve(appRoot, "..", "..", "..", "bin", baseName),
    process.platform === "win32" ? `${baseName}.cmd` : baseName,
    baseName,
  ]);

  return Array.from(candidates);
}

function defaultCommandRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        // Never route release-derived paths through a command shell. The candidate list includes
        // the real VS Code executable on Windows; .cmd candidates simply fail and fall through.
        shell: false,
      });
    } catch (error) {
      // Some Windows process-launch failures (including EINVAL) are thrown synchronously rather
      // than reported on ChildProcess#error. Treat them exactly like a failed candidate so the
      // updater can still try VS Code's other known launch paths.
      resolve({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Use the workbench installer first: it is the same VS Code-owned VSIX path exposed by the
 * Extensions view and avoids depending on a particular Windows CLI launcher. */
async function defaultVsixInstaller(vsixPath: string): Promise<void> {
  await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ExtensionUpdater {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fetcher: Fetcher = fetch,
    private readonly runCommand: CommandRunner = defaultCommandRunner,
    private readonly installFromVsix: VsixInstaller = defaultVsixInstaller,
    /** The running VS Code version; injectable so the engine gate is testable. */
    private readonly runningVscodeVersion: string = vscode.version ?? "0.0.0",
    /** Where each check's outcome is written. Automatic checks never show a failure, so without
     *  this a check that kept failing left no trace anywhere. */
    private readonly log: UpdateLog = () => {},
  ) {}

  /** The version whose update prompt is on screen now, so a later tick does not stack a second. */
  private promptOpenFor?: string;
  private retryTimer?: ReturnType<typeof setTimeout>;

  /**
   * The throttled, automatic check — run once at activation and then on every tick of
   * {@link scheduleUpdateChecks}. Every gate is re-read here rather than captured by the caller,
   * so a settings change takes effect on the next tick without a reload.
   */
  async maybeCheckForUpdates(): Promise<void> {
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) return;
    if (vscode.env.uiKind !== vscode.UIKind.Desktop) return;

    const config = getUpdateConfig();
    if (!config.checkOnStartup) return;

    const lastCheck = this.context.globalState.get<number>(LAST_CHECK_KEY) ?? 0;
    if ((Date.now() - lastCheck) < UPDATE_CHECK_MIN_ELAPSED_MS) return;

    await this.checkForUpdates({ manual: false });
  }

  /**
   * Keep checking for as long as the window lives.
   *
   * Without this the check ran only at activation, which made the interval a *ceiling on
   * staleness* rather than a period: a window left open for a week never re-checked, so an
   * install picked up a release only when its user happened to restart — and a fix shipped for a
   * bug they were hitting could sit unoffered indefinitely.
   *
   * Nothing is checked here directly; the gates (production, desktop, the setting, the throttle,
   * and the per-version dismissal) all live in {@link maybeCheckForUpdates}, so a user who
   * declined this version is not re-prompted every three hours.
   */
  scheduleUpdateChecks(): vscode.Disposable {
    const timer = setInterval(() => {
      // A timer callback sits outside any promise chain VS Code owns, so an escaped rejection
      // here would surface as an unhandled rejection in the extension host.
      void this.maybeCheckForUpdates().catch((error: unknown) => {
        console.error("Blacksite: scheduled update check failed", error);
      });
    }, UPDATE_CHECK_INTERVAL_MS);
    // A background poll must never be the reason the host process stays alive.
    timer.unref?.();
    return new vscode.Disposable(() => {
      clearInterval(timer);
      if (this.retryTimer) clearTimeout(this.retryTimer);
    });
  }

  /** After an automatic check fails, try again in {@link FAILED_CHECK_RETRY_MS} rather than at
   *  the next interval. The throttle is set back to match, so the retry is not turned away. */
  private async scheduleRetryAfterFailure(): Promise<void> {
    await this.context.globalState.update(LAST_CHECK_KEY, Date.now() - UPDATE_CHECK_MIN_ELAPSED_MS + FAILED_CHECK_RETRY_MS);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.maybeCheckForUpdates().catch((error: unknown) => {
        console.error("Blacksite: update check retry failed", error);
      });
    }, FAILED_CHECK_RETRY_MS);
    this.retryTimer.unref?.();
  }

  async checkForUpdates(options: { manual: boolean }): Promise<void> {
    const extensionPackage = this.context.extension.packageJSON as ExtensionPackageInfo;
    const config = getUpdateConfig();
    const extensionPackageName = String(extensionPackage.name ?? "");
    const repositorySlug = resolveRepositorySlug(config.repository, extensionPackage);
    const currentVersion = String(extensionPackage.version ?? "0.0.0");
    const channel = config.includePrerelease ? "prerelease" : "stable";
    const kind = options.manual ? "manual" : "automatic";

    let updateInfo: UpdateInfo | null;
    try {
      updateInfo = await this.resolveLatestRelease(config, repositorySlug, extensionPackageName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`${kind} check failed (${channel} channel, installed ${currentVersion}): ${message}`);
      if (options.manual) {
        void vscode.window.showWarningMessage(`Blacksite: Update check failed. ${message}`);
        await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
      } else {
        await this.scheduleRetryAfterFailure();
      }
      return;
    }
    // Stamped before any prompt, not after it: a prompt nobody has answered yet must not hold the
    // throttle open so that every later tick checks — and prompts — again.
    await this.context.globalState.update(LAST_CHECK_KEY, Date.now());

    const found = updateInfo ? `${updateInfo.version} from ${updateInfo.source ?? "github"}` : "no release";
    if (!updateInfo || compareVersions(updateInfo.version, currentVersion) <= 0) {
      this.log(`${kind} check (${channel} channel): ${found}; installed ${currentVersion} is up to date.`);
      if (options.manual) {
        void vscode.window.showInformationMessage(`Blacksite ${currentVersion} is up to date.`);
      }
      return;
    }

    if (!options.manual) {
      const dismissedVersion = this.context.globalState.get<string>(DISMISSED_VERSION_KEY);
      if (dismissedVersion === updateInfo.version) {
        this.log(`${kind} check (${channel} channel): ${found}; not offered again, it was dismissed. Use "Blacksite: Check for Updates" to see it.`);
        return;
      }
      if (this.promptOpenFor === updateInfo.version) {
        this.log(`${kind} check (${channel} channel): ${found}; its update prompt is still open.`);
        return;
      }
    }

    if (!engineSatisfied(updateInfo.minimumVscodeVersion, this.runningVscodeVersion)) {
      this.log(`${kind} check (${channel} channel): ${found} needs VS Code ${engineFloorLabel(updateInfo.minimumVscodeVersion ?? "")}; this is ${this.runningVscodeVersion}.`);
      await this.promptEngineTooOld(updateInfo, options.manual);
      return;
    }

    this.log(`${kind} check (${channel} channel): offering ${found} over installed ${currentVersion}.`);
    this.promptOpenFor = updateInfo.version;
    try {
      await this.promptForUpdate(currentVersion, updateInfo, options.manual);
    } finally {
      if (this.promptOpenFor === updateInfo.version) this.promptOpenFor = undefined;
    }
  }

  /**
   * Manifest first, GitHub API second.
   *
   * The manifest only ever describes the newest stable release, so a user who opted into
   * prereleases skips it entirely — otherwise they would be pinned to stable by a source
   * that cannot express what they asked for.
   */
  private async resolveLatestRelease(
    config: { includePrerelease: boolean; manifestUrl: string },
    repositorySlug: string | null,
    extensionPackageName: string,
  ): Promise<UpdateInfo | null> {
    if (!config.includePrerelease) {
      const fromManifest = await this.fetchReleaseManifest(config.manifestUrl, extensionPackageName);
      if (fromManifest) return fromManifest;
    }
    if (!repositorySlug) {
      throw new Error(
        "The release manifest was unavailable and no GitHub repository is configured as a fallback (blacksite.updates.repository).",
      );
    }
    try {
      return await this.fetchLatestRelease(repositorySlug, config.includePrerelease, extensionPackageName);
    } catch (error) {
      // Prereleases are only listed by the GitHub API, whose unauthenticated budget is per IP.
      // When it fails, the stable manifest still answers whether a newer stable release exists,
      // so a prerelease user is never left with no update source at all.
      if (!config.includePrerelease) throw error;
      const fromManifest = await this.fetchReleaseManifest(config.manifestUrl, extensionPackageName);
      if (!fromManifest) throw error;
      this.log(`GitHub releases unavailable (${error instanceof Error ? error.message : String(error)}); checked the stable manifest instead.`);
      return fromManifest;
    }
  }

  /** Never throws: the manifest is an optimisation, and any failure falls back to the API. */
  private async fetchReleaseManifest(manifestUrl: string, extensionPackageName: string): Promise<UpdateInfo | null> {
    // The manifest names both the download and its digest, so over plain HTTP anyone on the
    // path could substitute a VSIX that verifies. Treat a non-HTTPS manifest as unavailable.
    if (!/^https:\/\//i.test(manifestUrl)) return null;
    try {
      const response = await this.fetcher(manifestUrl, {
        headers: { Accept: "application/json", "User-Agent": "blacksite-vscode-updater" },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      // A misconfigured custom domain is the likely failure here, and parking pages answer
      // every path with 200 + HTML rather than a 404 — so status alone does not prove this is
      // a manifest. Checking the content type keeps that case on the quiet fallback path
      // instead of relying on a JSON parse throwing.
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (contentType && !/\bjson\b/i.test(contentType)) return null;
      return parseReleaseManifest(await response.json() as unknown, extensionPackageName);
    } catch {
      return null;
    }
  }

  private async fetchLatestRelease(repositorySlug: string, includePrerelease: boolean, extensionPackageName: string): Promise<UpdateInfo | null> {
    const response = await this.fetcher(buildGitHubApiUrl(repositorySlug), {
      headers: buildGitHubHeaders("application/vnd.github+json"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(describeGitHubHttpError(response.status, response.statusText, repositorySlug));
    }

    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error("GitHub returned an invalid releases payload.");

    // The highest eligible version, not the first listed. GitHub orders this list by each
    // release's created_at, which is the date of its tagged commit rather than of publishing, so
    // the order says nothing about versions: two releases tagged on the same commit tie, and a tag
    // placed on an older commit sorts below releases older than it.
    let best: UpdateInfo | null = null;
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const release = item as GithubRelease;
      if (release.draft) continue;
      if (!includePrerelease && release.prerelease) continue;

      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = selectVsixAsset(assets, extensionPackageName);
      if (!asset) continue;

      const version = extractReleaseVersion(release, asset, extensionPackageName);
      if (!version) continue;

      if (!best || compareVersions(version, best.version) > 0) {
        best = {
          source: "github",
          version,
          asset,
          releaseUrl: release.html_url,
          releaseTitle: release.name?.trim() || release.tag_name,
        };
      }
    }

    return best;
  }

  /**
   * The release needs a newer VS Code than this one. Offering "Update Now" would download a
   * VSIX VS Code refuses to install, so say what is actually needed instead. Automatic checks
   * record the version as dismissed so the same notice does not return every three hours;
   * a manual check always answers.
   */
  private async promptEngineTooOld(updateInfo: UpdateInfo, manual: boolean): Promise<void> {
    const floor = engineFloorLabel(updateInfo.minimumVscodeVersion ?? "");
    const action = await vscode.window.showInformationMessage(
      `Blacksite ${updateInfo.version} needs VS Code ${floor} or newer (you have ${this.runningVscodeVersion}). Update VS Code, then update Blacksite.`,
      "View Release",
    );
    if (action === "View Release") {
      await vscode.env.openExternal(vscode.Uri.parse(updateInfo.releaseUrl));
    }
    if (!manual) {
      await this.context.globalState.update(DISMISSED_VERSION_KEY, updateInfo.version);
    }
  }

  private async promptForUpdate(currentVersion: string, updateInfo: UpdateInfo, manual: boolean): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      `Blacksite ${updateInfo.version} is available (installed ${currentVersion}).`,
      "Update Now",
      "View Release",
      "Later",
    );

    if (action === "Update Now") {
      await this.installUpdate(updateInfo);
      return;
    }

    if (action === "View Release") {
      await vscode.env.openExternal(vscode.Uri.parse(updateInfo.releaseUrl));
    }

    if (!manual) {
      await this.context.globalState.update(DISMISSED_VERSION_KEY, updateInfo.version);
    }
  }

  private async installUpdate(updateInfo: UpdateInfo): Promise<void> {
    // Every download gets its own mkdtemp directory, and the VSIX inside it is dead weight the
    // moment the install returns — VS Code has copied what it needs. Left behind, each offered
    // update strands another ~7 MB in the OS temp directory for the life of the machine.
    let downloadDir: string | undefined;
    try {
      const vsixPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing Blacksite ${updateInfo.version}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Downloading VSIX…" });
          const downloadedPath = await this.downloadVsix(updateInfo.asset, updateInfo.version);
          downloadDir = path.dirname(downloadedPath);

          progress.report({ message: "Installing into VS Code…" });
          await this.installVsix(downloadedPath);
          return downloadedPath;
        },
      );

      await this.context.globalState.update(DISMISSED_VERSION_KEY, undefined);

      const action = await vscode.window.showInformationMessage(
        `Blacksite ${updateInfo.version} was installed. Reload Window to activate it.`,
        "Reload Window",
        "View Release",
      );
      if (action === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else if (action === "View Release") {
        await vscode.env.openExternal(vscode.Uri.parse(updateInfo.releaseUrl));
      }

      void vsixPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showWarningMessage(
        `Blacksite: Automatic update failed. ${message}`,
        "View Release",
      );
      if (action === "View Release") {
        await vscode.env.openExternal(vscode.Uri.parse(updateInfo.releaseUrl));
      }
    } finally {
      if (downloadDir) {
        // Best effort: a temp file we failed to remove is untidy, never incorrect, and must not
        // turn a successful install into a reported failure.
        await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async downloadVsix(asset: GithubReleaseAsset, version: string): Promise<string> {
    const expectedHash = validateReleaseAssetMetadata(asset, version);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blacksite-vscode-update-"));

    // The filename is built from `version`, never from the manifest's own `fileName` (see
    // parseReleaseManifest) — so a manifest crafted with a traversal path
    // ("../../somewhere/payload") has nothing to steer. `version` itself reaches here only
    // through validateReleaseAssetMetadata's UPDATE_VERSION_RE, which admits no separators.
    const destination = path.join(tempDir, `blacksite-vscode-${version}.vsix`);
    try {
      // Always the public browser download URL. The API asset URL exists only to serve
      // private-repo downloads with a credential, which is exactly what this no longer does.
      const response = await this.fetcher(asset.browser_download_url, {
        headers: buildGitHubHeaders("application/octet-stream"),
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`VSIX download failed with ${response.status} ${response.statusText}.`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      verifyVsixBytes(bytes, expectedHash);
      /* The manifest carries the engine range, the GitHub API (prereleases, manifest outages)
         does not — so read it from the verified package itself before handing it to VS Code,
         whose own refusal would otherwise surface as an opaque install failure. */
      const engineRange = readVsixEngineRange(bytes);
      if (engineRange && !engineSatisfied(engineRange, this.runningVscodeVersion)) {
        throw new Error(
          `Blacksite ${version} needs VS Code ${engineFloorLabel(engineRange)} or newer (you have ${this.runningVscodeVersion}). Update VS Code first.`,
        );
      }
      await fs.writeFile(destination, bytes);
      return destination;
    } catch (error) {
      // A download that never produced an installable VSIX still created its directory. The
      // caller only cleans up directories it was handed, so failures clean up their own.
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async installVsix(vsixPath: string): Promise<void> {
    let lastFailure = "";
    try {
      await this.installFromVsix(vsixPath);
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const candidates = buildCliCommandCandidates();

    for (const command of candidates) {
      let result: CommandResult;
      try {
        result = await this.runCommand(command, ["--install-extension", vsixPath, "--force"]);
      } catch (error) {
        // A runner may reject before it has a ChildProcess (Windows can throw spawn EINVAL
        // synchronously). Do not let one bad launcher prevent the remaining candidates.
        lastFailure = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (result.code === 0) return;

      const output = `${result.stderr}\n${result.stdout}`.trim();
      if (output) lastFailure = output;
    }

    throw new Error(lastFailure || "Unable to locate a usable VS Code installer command.");
  }

}
