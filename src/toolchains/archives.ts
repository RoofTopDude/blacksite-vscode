/* Exact archives for project-scoped Node and JDK installs, resolved when the plan is built so the
   script can pin each download to a SHA-256 the user sees in the preview.

   Node: the newest release of the requested major from nodejs.org's release index, and its hash
   from that release's SHASUMS256.txt. JDK: the latest Temurin build of the requested feature
   release from the Adoptium API, which returns the package link with its checksum.

   Both are fetched over HTTPS from the projects' own release services and only when the user has
   chosen a project-scoped install. No result is cached: versions move, and a stale hash would make
   the install fail its own check. */

import { nodeArchiveName, type Platform, type ResolvedArchive } from "./recipes.js";

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const TIMEOUT_MS = 15_000;

async function get(fetchImpl: Fetch, url: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveNodeArchive(major: string, platform: Platform, arch: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<ResolvedArchive> {
  if (!/^\d+$/.test(major)) throw new Error(`Not a Node major version: ${major}`);
  const index = await (await get(fetchImpl, "https://nodejs.org/dist/index.json")).json() as Array<{ version?: string }>;
  const release = index.find((entry) => typeof entry.version === "string" && entry.version.startsWith(`v${major}.`));
  if (!release?.version) throw new Error(`nodejs.org lists no Node ${major} release`);
  const version = release.version.replace(/^v/, "");
  const fileName = nodeArchiveName(version, platform, arch);
  const sums = await (await get(fetchImpl, `https://nodejs.org/dist/v${version}/SHASUMS256.txt`)).text();
  const line = sums.split(/\r?\n/).find((entry) => entry.trim().endsWith(`  ${fileName}`) || entry.trim().endsWith(` ${fileName}`));
  const sha256 = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`No checksum published for ${fileName}`);
  return { url: `https://nodejs.org/dist/v${version}/${fileName}`, sha256, fileName, version };
}

export async function resolveTemurinArchive(feature: string, platform: Platform, arch: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<ResolvedArchive> {
  if (!/^\d+$/.test(feature)) throw new Error(`Not a Java feature release: ${feature}`);
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
  const cpu = arch === "arm64" ? "aarch64" : "x64";
  const url = `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=${cpu}&image_type=jdk&os=${os}&vendor=eclipse`;
  const assets = await (await get(fetchImpl, url)).json() as Array<{ binary?: { package?: { link?: string; checksum?: string; name?: string } }; version?: { semver?: string } }>;
  const pkg = assets[0]?.binary?.package;
  if (!pkg?.link || !pkg.checksum || !pkg.name) throw new Error(`Adoptium has no Temurin ${feature} JDK for ${os}/${cpu}`);
  return { url: pkg.link, sha256: pkg.checksum.toLowerCase(), fileName: pkg.name, version: assets[0]?.version?.semver ?? feature };
}
