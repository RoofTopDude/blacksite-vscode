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

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
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

function getUpdateConfig(): { checkOnStartup: boolean; includePrerelease: boolean; repository: string } {
  const cfg = vscode.workspace.getConfiguration("blacksite");
  return {
    checkOnStartup: cfg.get<boolean>("updates.checkOnStartup", true),
    includePrerelease: cfg.get<boolean>("updates.includePrerelease", false),
    repository: cfg.get<string>("updates.repository", "").trim(),
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

  if (extensionPackageName) {
    const prefix = `${extensionPackageName.toLowerCase()}-`;
    const exact = vsixAssets.find((asset) => asset.name.toLowerCase().startsWith(prefix));
    if (exact) return exact;
  }

  return vsixAssets[0] ?? null;
}

interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string>;
}

function parseVersion(version: string): ParsedVersion | null {
  const normalized = version.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  const [corePartRaw, prereleasePart] = normalized.split("-", 2);
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
    const repositorySlug = resolveRepositorySlug(config.repository, extensionPackage);
    if (!repositorySlug) {
      if (options.manual) {
        void vscode.window.showWarningMessage(
          "Blacksite: No valid GitHub repository is configured for VS Code extension updates.",
        );
      }
      return;
    }

    const currentVersion = String(extensionPackage.version ?? "0.0.0");

    try {
      const updateInfo = await this.fetchLatestRelease(repositorySlug, config.includePrerelease, String(extensionPackage.name ?? ""));
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

  private async fetchLatestRelease(repositorySlug: string, includePrerelease: boolean, extensionPackageName: string): Promise<UpdateInfo | null> {
    const response = await this.fetcher(buildGitHubApiUrl(repositorySlug), {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "blacksite-vscode-updater",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} ${response.statusText}.`);
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
    const response = await this.fetcher(asset.browser_download_url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "blacksite-vscode-updater",
      },
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
