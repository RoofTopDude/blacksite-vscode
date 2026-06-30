import { describe, expect, it } from "vitest";
import {
  compareVersions,
  describeGitHubHttpError,
  extractVersionFromVsixName,
  normalizeGithubRepositorySlug,
  selectVsixAsset,
} from "../../src/update-service.js";

describe("normalizeGithubRepositorySlug", () => {
  it("accepts owner/repo input", () => {
    expect(normalizeGithubRepositorySlug("RoofTopDude/Blacksite-AI")).toBe("RoofTopDude/Blacksite-AI");
  });

  it("extracts from https urls", () => {
    expect(normalizeGithubRepositorySlug("https://github.com/RoofTopDude/Blacksite-AI.git")).toBe("RoofTopDude/Blacksite-AI");
  });

  it("extracts from ssh urls", () => {
    expect(normalizeGithubRepositorySlug("git@github.com:RoofTopDude/Blacksite-AI.git")).toBe("RoofTopDude/Blacksite-AI");
  });

  it("returns null for unsupported hosts", () => {
    expect(normalizeGithubRepositorySlug("https://gitlab.com/RoofTopDude/Blacksite-AI")).toBeNull();
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
});

describe("describeGitHubHttpError", () => {
  it("explains private repo failures when no token is configured", () => {
    expect(describeGitHubHttpError(404, "Not Found", "RoofTopDude/Blacksite-AI", false))
      .toContain("may be private");
  });

  it("explains token access failures separately", () => {
    expect(describeGitHubHttpError(403, "Forbidden", "RoofTopDude/Blacksite-AI", true))
      .toContain("configured GitHub token");
  });
});
