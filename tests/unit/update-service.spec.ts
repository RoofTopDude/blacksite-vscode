import { describe, expect, it } from "vitest";
import {
  compareVersions,
  describeGitHubHttpError,
  extractVersionFromVsixName,
  normalizeGithubRepositorySlug,
  parseReleaseManifest,
  selectVsixAsset,
} from "../../src/update-service.js";

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

  it("synthesises a filename when the manifest omits one", () => {
    const { fileName: _dropped, ...withoutName } = MANIFEST;
    expect(parseReleaseManifest(withoutName, "blacksite-vscode")?.asset.name)
      .toBe("blacksite-vscode-1.2.3.vsix");
  });
});
