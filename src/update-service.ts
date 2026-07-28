import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const LAST_CHECK_KEY = "blacksite.updates.lastCheckAt";
const DISMISSED_VERSION_KEY = "blacksite.updates.dismissedVersion";
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RELEASES_PAGE_SIZE = 10;
const API_TIMEOUT_MS = 15_000;

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
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  url?: string;
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
  version: string;
  asset: GithubReleaseAsset;
  releaseUrl: string;
  releaseTitle: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ExtensionPackageInfo {
  name?: string;
  version?: string;
  repository?: unknown;
}

function getUpdateConfig(): { checkOnStartup: boolean; includePrerelease: boolean; repository: string; manifestUrl: string } {
  const cfg = vscode.workspace.getConfiguration("blacksite");
  return {
    checkOnStartup: cfg.get<boolean>("updates.checkOnStartup", true),
    includePrerelease: cfg.get<boolean>("updates.includePrerelease", false),
    repository: cfg.get<string>("updates.repository", "").trim(),
    manifestUrl: cfg.get<string>("updates.manifestUrl", DEFAULT_MANIFEST_URL).trim() || DEFAULT_MANIFEST_URL,
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

  const fileName = typeof manifest.fileName === "string" && manifest.fileName
    ? manifest.fileName
    : `${extensionPackageName || "blacksite-vscode"}-${rawVersion}.vsix`;

  return {
    version: rawVersion.replace(/^v/, ""),
    asset: { name: fileName, browser_download_url: downloadUrl },
    releaseUrl: typeof manifest.releaseUrl === "string" && manifest.releaseUrl ? manifest.releaseUrl : DEFAULT_MANIFEST_URL,
    releaseTitle: typeof manifest.name === "string" && manifest.name ? manifest.name : `Blacksite ${rawVersion}`,
  };
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

  const candidates = new Set<string>([
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
    const child = spawn(command, args, {
      windowsHide: true,
      shell: process.platform === "win32",
    });

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ExtensionUpdater {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fetcher: Fetcher = fetch,
    private readonly runCommand: CommandRunner = defaultCommandRunner,
  ) {}

  async maybeCheckForUpdatesOnStartup(): Promise<void> {
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) return;
    if (vscode.env.uiKind !== vscode.UIKind.Desktop) return;

    const config = getUpdateConfig();
    if (!config.checkOnStartup) return;

    const lastCheck = this.context.globalState.get<number>(LAST_CHECK_KEY) ?? 0;
    if ((Date.now() - lastCheck) < UPDATE_CHECK_INTERVAL_MS) return;

    await this.checkForUpdates({ manual: false });
  }

  async checkForUpdates(options: { manual: boolean }): Promise<void> {
    const extensionPackage = this.context.extension.packageJSON as ExtensionPackageInfo;
    const config = getUpdateConfig();
    const extensionPackageName = String(extensionPackage.name ?? "");
    const repositorySlug = resolveRepositorySlug(config.repository, extensionPackage);
    const currentVersion = String(extensionPackage.version ?? "0.0.0");

    try {
      const updateInfo = await this.resolveLatestRelease(config, repositorySlug, extensionPackageName);
      if (!updateInfo || compareVersions(updateInfo.version, currentVersion) <= 0) {
        if (options.manual) {
          void vscode.window.showInformationMessage(`Blacksite ${currentVersion} is up to date.`);
        }
        return;
      }

      if (!options.manual) {
        const dismissedVersion = this.context.globalState.get<string>(DISMISSED_VERSION_KEY);
        if (dismissedVersion === updateInfo.version) return;
      }

      await this.promptForUpdate(currentVersion, updateInfo, options.manual);
    } catch (error) {
      if (options.manual) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`Blacksite: Update check failed. ${message}`);
      }
    } finally {
      await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
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
    return this.fetchLatestRelease(repositorySlug, config.includePrerelease, extensionPackageName);
  }

  /** Never throws: the manifest is an optimisation, and any failure falls back to the API. */
  private async fetchReleaseManifest(manifestUrl: string, extensionPackageName: string): Promise<UpdateInfo | null> {
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

      return {
        version,
        asset,
        releaseUrl: release.html_url,
        releaseTitle: release.name?.trim() || release.tag_name,
      };
    }

    return null;
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
    try {
      const vsixPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing Blacksite ${updateInfo.version}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Downloading VSIX…" });
          const downloadedPath = await this.downloadVsix(updateInfo.asset);

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
    }
  }

  private async downloadVsix(asset: GithubReleaseAsset): Promise<string> {
    const tempDir = path.join(os.tmpdir(), "blacksite-vscode-updates");
    await fs.mkdir(tempDir, { recursive: true });

    const destination = path.join(tempDir, asset.name);
    // Always the public browser download URL. The API asset URL exists only to serve
    // private-repo downloads with a credential, which is exactly what this no longer does.
    const response = await this.fetcher(asset.browser_download_url, {
      headers: buildGitHubHeaders("application/octet-stream"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`VSIX download failed with ${response.status} ${response.statusText}.`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destination, bytes);
    return destination;
  }

  private async installVsix(vsixPath: string): Promise<void> {
    const candidates = buildCliCommandCandidates();
    let lastFailure = "Unable to locate a usable VS Code CLI command.";

    for (const command of candidates) {
      const result = await this.runCommand(command, ["--install-extension", vsixPath, "--force"]);
      if (result.code === 0) return;

      const output = `${result.stderr}\n${result.stdout}`.trim();
      if (output) lastFailure = output;
    }

    throw new Error(lastFailure);
  }

}
