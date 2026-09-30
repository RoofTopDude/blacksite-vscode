import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  compareVersions,
  describeGitHubHttpError,
  engineFloorLabel,
  engineSatisfied,
  ExtensionUpdater,
  extractVersionFromVsixName,
  normalizeGithubRepositorySlug,
  parseReleaseManifest,
  readVsixEngineRange,
  selectVsixAsset,
  UPDATE_CHECK_INTERVAL_MS,
  validateReleaseAssetMetadata,
  verifyVsixBytes,
} from "../../src/update-service.js";
import * as vscodeMock from "./helpers/vscode-mock.js";

describe("normalizeGithubRepositorySlug", () => {
  it("accepts owner/repo input", () => {
    expect(normalizeGithubRepositorySlug("RoofTopDude/blacksite-vscode")).toBe("RoofTopDude/blacksite-vscode");
  });

  it("extracts from https urls", () => {
    expect(normalizeGithubRepositorySlug("https://github.com/RoofTopDude/blacksite-vscode.git")).toBe("RoofTopDude/blacksite-vscode");
  });

  it("extracts from ssh urls", () => {
    expect(normalizeGithubRepositorySlug("git@github.com:RoofTopDude/blacksite-vscode.git")).toBe("RoofTopDude/blacksite-vscode");
  });

  it("returns null for unsupported hosts", () => {
    expect(normalizeGithubRepositorySlug("https://gitlab.com/RoofTopDude/blacksite-vscode")).toBeNull();
  });
});

describe("extractVersionFromVsixName", () => {
  it("extracts a stable version", () => {
    expect(extractVersionFromVsixName("blacksite-vscode-1.2.3.vsix", "blacksite-vscode")).toBe("1.2.3");
  });

  it("extracts a prerelease version", () => {
    expect(extractVersionFromVsixName("blacksite-vscode-1.2.3-beta.4.vsix", "blacksite-vscode")).toBe("1.2.3-beta.4");
  });

  it("returns null when no semver is present", () => {
    expect(extractVersionFromVsixName("blacksite-vscode-latest.vsix", "blacksite-vscode")).toBeNull();
  });
});

describe("selectVsixAsset", () => {
  it("prefers an asset that matches the extension package name", () => {
    const asset = selectVsixAsset(
      [
        { name: "other-extension-1.0.0.vsix", browser_download_url: "https://example.com/other" },
        { name: "blacksite-vscode-1.0.0.vsix", browser_download_url: "https://example.com/blacksite" },
      ],
      "blacksite-vscode",
    );
    expect(asset?.name).toBe("blacksite-vscode-1.0.0.vsix");
  });

  it("prefers the newest matching asset when multiple versions are present", () => {
    const asset = selectVsixAsset(
      [
        { name: "blacksite-vscode-0.1.0.vsix", browser_download_url: "https://example.com/old" },
        { name: "blacksite-vscode-0.1.2.vsix", browser_download_url: "https://example.com/new" },
      ],
      "blacksite-vscode",
    );
    expect(asset?.name).toBe("blacksite-vscode-0.1.2.vsix");
  });

  it("returns the single vsix asset when only one exists", () => {
    const asset = selectVsixAsset(
      [{ name: "blacksite-vscode-1.0.0.vsix", browser_download_url: "https://example.com/blacksite" }],
      "blacksite-vscode",
    );
    expect(asset?.name).toBe("blacksite-vscode-1.0.0.vsix");
  });

  it("returns null when no vsix assets exist", () => {
    expect(selectVsixAsset([{ name: "release.txt", browser_download_url: "https://example.com/release" }], "blacksite-vscode")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares numeric segments correctly", () => {
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
  });

  it("treats stable builds as newer than prereleases", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  });

  it("compares prerelease identifiers", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBeLessThan(0);
  });

  it("keeps hyphenated prerelease identifiers distinct", () => {
    // Regression: split("-", 2) used to drop everything after the second hyphen,
    // collapsing these to an equal "beta" prerelease.
    expect(compareVersions("1.2.3-beta-3", "1.2.3-beta-2")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-beta-2", "1.2.3-beta-3")).toBeLessThan(0);
    expect(compareVersions("1.2.3-beta-2", "1.2.3-beta-2")).toBe(0);
  });
});

describe("describeGitHubHttpError", () => {
  it("attributes 403/429 to the unauthenticated rate limit, not permissions", () => {
    // Releases are public now, so a 403 here is the 60/hour/IP budget rather than an
    // access problem — telling the user to configure a token would send them nowhere.
    for (const status of [403, 429]) {
      const message = describeGitHubHttpError(status, "Forbidden", "RoofTopDude/blacksite-vscode");
      expect(message).toContain("rate limit");
      expect(message).not.toMatch(/token|PAT/i);
    }
  });

  it("points a 404 at the configured repository", () => {
    expect(describeGitHubHttpError(404, "Not Found", "RoofTopDude/blacksite-vscode"))
      .toContain("blacksite.updates.repository");
  });

  it("never asks the user for a credential", () => {
    for (const status of [401, 404, 500]) {
      expect(describeGitHubHttpError(status, "Err", "owner/repo")).not.toMatch(/token|PAT|Authorization/i);
    }
  });
});

describe("parseReleaseManifest", () => {
  const MANIFEST = {
    version: "1.2.3",
    tag: "v1.2.3",
    name: "Blacksite 1.2.3",
    releaseUrl: "https://github.com/RoofTopDude/blacksite-vscode/releases/tag/v1.2.3",
    downloadUrl: "https://github.com/RoofTopDude/blacksite-vscode/releases/download/v1.2.3/blacksite-vscode-1.2.3.vsix",
    fileName: "blacksite-vscode-1.2.3.vsix",
    size: 4_200_000,
    digest: `sha256:${"a".repeat(64)}`,
  };

  it("reads the published manifest shape produced by the pages workflow", () => {
    const info = parseReleaseManifest(MANIFEST, "blacksite-vscode");
    expect(info?.version).toBe("1.2.3");
    expect(info?.asset.browser_download_url).toBe(MANIFEST.downloadUrl);
    expect(info?.asset.name).toBe("blacksite-vscode-1.2.3.vsix");
    expect(info?.releaseUrl).toBe(MANIFEST.releaseUrl);
  });

  it("tolerates a leading v on the version so comparison stays numeric", () => {
    expect(parseReleaseManifest({ ...MANIFEST, version: "v1.2.3" })?.version).toBe("1.2.3");
  });

  it("returns null for the placeholder CI writes before the first release", () => {
    // pages.yml emits this when no release exists yet; it must fall through to the API
    // rather than surfacing as an update-check failure.
    expect(parseReleaseManifest({ version: null, note: "No release published yet." })).toBeNull();
  });

  it("returns null when the manifest cannot produce a download", () => {
    expect(parseReleaseManifest({ ...MANIFEST, downloadUrl: "" })).toBeNull();
    expect(parseReleaseManifest({ ...MANIFEST, version: "" })).toBeNull();
    expect(parseReleaseManifest(null)).toBeNull();
    expect(parseReleaseManifest("not json")).toBeNull();
    expect(parseReleaseManifest([MANIFEST])).toBeNull();
  });

  it("falls back to the GitHub API when a manifest has no signed digest", () => {
    const { digest: _digest, ...unsigned } = MANIFEST;
    expect(parseReleaseManifest(unsigned, "blacksite-vscode")).toBeNull();
  });

  it("rejects malformed versions before they can shape a download path", () => {
    expect(parseReleaseManifest({ ...MANIFEST, version: "../../payload" }, "blacksite-vscode")).toBeNull();
  });

  it("rejects an HTML parking page served with a 200", () => {
    // A custom domain that does not resolve to Pages typically answers every path with
    // 200 + HTML rather than 404, so this must not be mistaken for a manifest.
    expect(parseReleaseManifest("<!doctype html><html><title>Coming Soon</title></html>")).toBeNull();
  });

  it("synthesises a filename when the manifest omits one", () => {
    const { fileName: _dropped, ...withoutName } = MANIFEST;
    expect(parseReleaseManifest(withoutName, "blacksite-vscode")?.asset.name)
      .toBe("blacksite-vscode-1.2.3.vsix");
  });
});

/**
 * The periodic check.
 *
 * Before this the check ran only at activation, which made the interval a ceiling on staleness
 * rather than a period: a window left open for a week never re-checked, so an install picked up a
 * release only when its user happened to restart.
 */
describe("ExtensionUpdater.scheduleUpdateChecks", () => {
  const MANIFEST_BODY = {
    version: "9.9.9",
    downloadUrl: "https://example.com/blacksite-vscode-9.9.9.vsix",
    fileName: "blacksite-vscode-9.9.9.vsix",
    releaseUrl: "https://example.com/release",
    name: "Blacksite v9.9.9",
    digest: `sha256:${"b".repeat(64)}`,
  };

  function createUpdater() {
    const globalStore = new Map<string, unknown>();
    const fetcher = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => MANIFEST_BODY,
    })) as unknown as Parameters<typeof ExtensionUpdater.prototype.constructor>[1];

    const context = {
      extensionMode: vscodeMock.ExtensionMode.Production,
      extension: { packageJSON: { name: "blacksite-vscode", version: "1.0.0" } },
      globalState: {
        get: <T>(key: string, fallback?: T): T | undefined => (globalStore.has(key) ? globalStore.get(key) as T : fallback),
        update: async (key: string, value: unknown): Promise<void> => { globalStore.set(key, value); },
      },
    };

    return { updater: new ExtensionUpdater(context as never, fetcher as never), fetcher: fetcher as unknown as ReturnType<typeof vi.fn>, globalStore };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vscodeMock.workspace.__clearConfig();
    vscodeMock.env.uiKind = vscodeMock.UIKind.Desktop;
  });

  afterEach(() => {
    vi.useRealTimers();
    vscodeMock.workspace.__clearConfig();
  });

  it("keeps checking on the interval for as long as the window lives", async () => {
    const { updater, fetcher } = createUpdater();
    const subscription = updater.scheduleUpdateChecks();

    for (let tick = 1; tick <= 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(fetcher, `tick ${tick}`).toHaveBeenCalledTimes(tick);
    }

    subscription.dispose();
  });

  /**
   * The subtle one. `lastCheckAt` is stamped when a check *finishes*, so a tick firing exactly
   * one interval after the previous tick *began* measures marginally less than one interval. With
   * the throttle set equal to the interval, every second tick would be turned away by the throttle
   * its own predecessor set — halving the real cadence to six hours, on a schedule far too slow to
   * catch by hand.
   */
  it("does not let a tick be rejected by the throttle its predecessor set", async () => {
    const { updater, fetcher, globalStore } = createUpdater();
    const subscription = updater.scheduleUpdateChecks();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Simulate the stamp landing *after* the tick that produced it — the real ordering, since
    // the check awaits a network round trip before writing it.
    globalStore.set("blacksite.updates.lastCheckAt", Date.now() + 30_000);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    subscription.dispose();
  });

  it("stops on dispose", async () => {
    const { updater, fetcher } = createUpdater();
    const subscription = updater.scheduleUpdateChecks();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);

    subscription.dispose();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 5);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-reads the opt-out on every tick, so turning it off needs no reload", async () => {
    const { updater, fetcher } = createUpdater();
    const subscription = updater.scheduleUpdateChecks();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);

    vscodeMock.workspace.__setConfig("blacksite.updates.checkOnStartup", false);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);

    subscription.dispose();
  });

  it("never polls outside a production desktop host", async () => {
    vscodeMock.env.uiKind = vscodeMock.UIKind.Web;
    const { updater, fetcher } = createUpdater();
    const subscription = updater.scheduleUpdateChecks();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(fetcher).not.toHaveBeenCalled();

    subscription.dispose();
  });

  it("checks every three hours", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe("update asset integrity", () => {
  const bytes = Buffer.from("verified vsix bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = {
    name: "blacksite-vscode-1.2.3.vsix",
    browser_download_url: "https://github.com/owner/repo/releases/download/v1.2.3/blacksite-vscode-1.2.3.vsix",
    digest: `sha256:${digest}`,
    size: bytes.length,
  };

  it("accepts a GitHub HTTPS asset with a published SHA-256 digest", () => {
    const expected = validateReleaseAssetMetadata(asset, "1.2.3");
    expect(() => verifyVsixBytes(bytes, expected)).not.toThrow();
  });

  it("rejects unsigned, off-origin, oversized, and digest-mismatched assets", () => {
    expect(() => validateReleaseAssetMetadata({ ...asset, digest: undefined }, "1.2.3")).toThrow(/digest/i);
    expect(() => validateReleaseAssetMetadata({ ...asset, browser_download_url: "https://attacker.example/update.vsix" }, "1.2.3")).toThrow(/github\.com/i);
    expect(() => validateReleaseAssetMetadata({ ...asset, size: 101 * 1024 * 1024 }, "1.2.3")).toThrow(/safety limit/i);
    expect(() => verifyVsixBytes(bytes, "0".repeat(64))).toThrow(/verification/i);
  });

  /* The timeout signal covers the body read, and the VSIX is ~15 MB. Downloading it on the API's
     15-second budget failed every "Update Now" below ~8 Mbit/s. */
  it("gives the VSIX download a budget of its own rather than the API's 15 seconds", async () => {
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { timeouts.push(ms); return realTimeout(ms); });
    const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }));
    const updater = new ExtensionUpdater({} as never, fetcher as never);

    const downloaded = await (updater as unknown as { downloadVsix(a: typeof asset, v: string): Promise<string> })
      .downloadVsix(asset, "1.2.3");

    try {
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeGreaterThanOrEqual(60_000);
    } finally {
      rmSync(dirname(downloaded), { recursive: true, force: true });
    }
  });
});

describe("ExtensionUpdater VSIX installation", () => {
  const context = { extension: { packageJSON: { name: "blacksite-vscode", version: "1.0.0" } } } as never;
  const noFetch = vi.fn() as never;

  it("uses VS Code's native VSIX installer before attempting a process launch", async () => {
    const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const installFromVsix = vi.fn(async () => undefined);
    const updater = new ExtensionUpdater(context, noFetch, runCommand, installFromVsix);

    await (updater as unknown as { installVsix(path: string): Promise<void> }).installVsix("C:\\Temp\\blacksite.vsix");

    expect(installFromVsix).toHaveBeenCalledWith("C:\\Temp\\blacksite.vsix");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("continues through CLI candidates when one launcher rejects with spawn EINVAL", async () => {
    const runCommand = vi.fn()
      .mockRejectedValueOnce(new Error("spawn EINVAL"))
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const installFromVsix = vi.fn(async () => { throw new Error("workbench installer unavailable"); });
    const updater = new ExtensionUpdater(context, noFetch, runCommand, installFromVsix);

    await (updater as unknown as { installVsix(path: string): Promise<void> }).installVsix("C:\\Temp\\blacksite.vsix");

    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});

/**
 * Where updates come from is a user decision. A repository's `.vscode/settings.json` must not be
 * able to point the updater at its own manifest or GitHub repo: the digest check only proves the
 * bytes match what that source published, so the result would be a genuine-looking "Blacksite
 * update" prompt that installs the repository's VSIX.
 */
describe("ExtensionUpdater update source", () => {
  function createUpdater() {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url));
      return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => "application/json" }, json: async () => ({}) };
    });
    const globalStore = new Map<string, unknown>();
    const context = {
      extensionMode: vscodeMock.ExtensionMode.Production,
      extension: { packageJSON: { name: "blacksite-vscode", version: "1.0.0", repository: "https://github.com/RoofTopDude/blacksite-vscode" } },
      globalState: {
        get: <T>(key: string): T | undefined => globalStore.get(key) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => { globalStore.set(key, value); },
      },
    };
    return { updater: new ExtensionUpdater(context as never, fetcher as never), urls };
  }

  beforeEach(() => vscodeMock.workspace.__clearConfig());
  afterEach(() => vscodeMock.workspace.__clearConfig());

  it("ignores a workspace-supplied manifest, repository, and prerelease opt-in", async () => {
    vscodeMock.workspace.__setConfig("blacksite.updates.manifestUrl", "https://attacker.example/latest.json");
    vscodeMock.workspace.__setConfig("blacksite.updates.repository", "attacker/payload");
    vscodeMock.workspace.__setConfig("blacksite.updates.includePrerelease", true);
    const { updater, urls } = createUpdater();

    await updater.checkForUpdates({ manual: false });

    expect(urls).toEqual([
      "https://rooftopdude.github.io/blacksite-vscode/latest.json",
      "https://api.github.com/repos/RoofTopDude/blacksite-vscode/releases?per_page=10",
    ]);
  });

  it("honours the same settings from user configuration", async () => {
    vscodeMock.workspace.__setGlobalConfig("blacksite.updates.manifestUrl", "https://mirror.example/latest.json");
    vscodeMock.workspace.__setGlobalConfig("blacksite.updates.repository", "fork-owner/blacksite-vscode");
    const { updater, urls } = createUpdater();

    await updater.checkForUpdates({ manual: false });

    expect(urls).toEqual([
      "https://mirror.example/latest.json",
      "https://api.github.com/repos/fork-owner/blacksite-vscode/releases?per_page=10",
    ]);
  });

  it("never fetches a manifest over plain HTTP", async () => {
    vscodeMock.workspace.__setGlobalConfig("blacksite.updates.manifestUrl", "http://mirror.example/latest.json");
    const { updater, urls } = createUpdater();

    await updater.checkForUpdates({ manual: false });

    expect(urls).toEqual(["https://api.github.com/repos/RoofTopDude/blacksite-vscode/releases?per_page=10"]);
  });
});

/**
 * A release that needs a newer VS Code than the running one must never reach "Update Now": VS
 * Code refuses the VSIX, and the user sees an opaque install failure every three hours. The
 * manifest publishes the engine range up front; the GitHub API path does not, so the verified
 * VSIX is read before install as well.
 */
describe("VS Code engine gate", () => {
  it("treats ^, >= and bare floors as minimums and ignores prerelease tags on the host", () => {
    expect(engineSatisfied("^1.139.0", "1.139.0")).toBe(true);
    expect(engineSatisfied("^1.139.0", "1.139.1")).toBe(true);
    expect(engineSatisfied("^1.139.0", "1.140.0-insider")).toBe(true);
    expect(engineSatisfied("^1.139.0", "1.138.2")).toBe(false);
    expect(engineSatisfied(">=1.139.0", "1.105.0")).toBe(false);
    expect(engineSatisfied("1.139.0", "1.2.0")).toBe(false);
  });

  it("never blocks on a missing or unparseable range", () => {
    expect(engineSatisfied(undefined, "1.0.0")).toBe(true);
    expect(engineSatisfied("", "1.0.0")).toBe(true);
    expect(engineSatisfied("~1.139 || 2", "1.0.0")).toBe(true);
    expect(engineFloorLabel("^1.139.0")).toBe("1.139.0");
  });

  it("reads minimumVscodeVersion from the published manifest", () => {
    const info = parseReleaseManifest({
      version: "2.0.0",
      downloadUrl: "https://github.com/o/r/releases/download/v2.0.0/blacksite-vscode-2.0.0.vsix",
      digest: `sha256:${"a".repeat(64)}`,
      minimumVscodeVersion: "^1.139.0",
    });
    expect(info?.minimumVscodeVersion).toBe("^1.139.0");
  });

  it("reads engines.vscode from a VSIX and tolerates garbage", () => {
    const vsix = zipSync({ "extension/package.json": strToU8(JSON.stringify({ engines: { vscode: "^1.139.0" } })) });
    expect(readVsixEngineRange(vsix)).toBe("^1.139.0");
    expect(readVsixEngineRange(zipSync({ "other.txt": strToU8("x") }))).toBeNull();
    expect(readVsixEngineRange(Buffer.from("not a zip"))).toBeNull();
  });

  function manifestUpdater(runningVersion: string) {
    const globalStore = new Map<string, unknown>();
    const fetcher = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        version: "2.0.0",
        downloadUrl: "https://github.com/o/r/releases/download/v2.0.0/blacksite-vscode-2.0.0.vsix",
        digest: `sha256:${"a".repeat(64)}`,
        minimumVscodeVersion: "^1.139.0",
      }),
    }));
    const context = {
      extensionMode: vscodeMock.ExtensionMode.Production,
      extension: { packageJSON: { name: "blacksite-vscode", version: "1.0.0" } },
      globalState: {
        get: <T>(key: string): T | undefined => globalStore.get(key) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => { globalStore.set(key, value); },
      },
    };
    const updater = new ExtensionUpdater(context as never, fetcher as never, undefined, undefined, runningVersion);
    return { updater, globalStore };
  }

  afterEach(() => vi.restoreAllMocks());

  it("explains the VS Code requirement instead of offering Update Now", async () => {
    const shown: string[][] = [];
    vi.spyOn(vscodeMock.window, "showInformationMessage").mockImplementation(async (...args: unknown[]) => {
      shown.push(args.map(String));
      return undefined;
    });
    const { updater, globalStore } = manifestUpdater("1.105.0");

    await updater.checkForUpdates({ manual: false });

    expect(shown).toHaveLength(1);
    expect(shown[0]![0]).toMatch(/needs VS Code 1\.139\.0 or newer \(you have 1\.105\.0\)/);
    expect(shown[0]).not.toContain("Update Now");
    // Automatic checks remember the notice so it does not return every three hours.
    expect(globalStore.get("blacksite.updates.dismissedVersion")).toBe("2.0.0");
  });

  it("offers the update normally on a new enough VS Code", async () => {
    const shown: string[][] = [];
    vi.spyOn(vscodeMock.window, "showInformationMessage").mockImplementation(async (...args: unknown[]) => {
      shown.push(args.map(String));
      return undefined;
    });
    const { updater } = manifestUpdater("1.139.1");

    await updater.checkForUpdates({ manual: true });

    expect(shown[0]).toContain("Update Now");
  });

  it("refuses a downloaded VSIX whose engine the running VS Code cannot satisfy", async () => {
    const vsix = Buffer.from(zipSync({ "extension/package.json": strToU8(JSON.stringify({ engines: { vscode: "^1.139.0" } })) }));
    const digest = createHash("sha256").update(vsix).digest("hex");
    const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: async () => vsix.buffer.slice(vsix.byteOffset, vsix.byteOffset + vsix.byteLength) }));
    const updater = new ExtensionUpdater({} as never, fetcher as never, undefined, undefined, "1.120.0");
    const asset = {
      name: "blacksite-vscode-2.0.0-pre.1.vsix",
      browser_download_url: "https://github.com/o/r/releases/download/v2.0.0-pre.1/blacksite-vscode-2.0.0-pre.1.vsix",
      digest: `sha256:${digest}`,
    };

    await expect((updater as unknown as { downloadVsix(a: typeof asset, v: string): Promise<string> })
      .downloadVsix(asset, "2.0.0-pre.1")).rejects.toThrow(/needs VS Code 1\.139\.0/);
  });
});
