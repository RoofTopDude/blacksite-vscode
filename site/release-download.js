/* Turns the generic "Download" links into a direct link to the newest released
   VSIX, and fills in the install command with its real filename.

   Loaded on every page, so the header's Download button resolves everywhere
   rather than only on the homepage. Everything here is progressive: with the
   manifest missing or JS off, every link still points at the releases page. */
(() => {
  const fallbackUrl = "https://github.com/RoofTopDude/blacksite-vscode/releases/latest";

  /* latest.json sits beside this script at the site root, and pages are served
     from more than one depth (docs/* is one down). Resolving against the
     script's own URL is depth-proof; a bare "latest.json" fetched from a doc
     page asks for docs/latest.json and quietly 404s into the fallback. */
  const manifestUrl = new URL("latest.json", document.currentScript?.src || location.href).href;

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const setText = (selector, text) => {
    document.querySelectorAll(selector).forEach((node) => { node.textContent = text; });
  };

  async function loadLatestRelease() {
    try {
      const response = await fetch(manifestUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`latest.json returned ${response.status}`);
      const release = await response.json();
      if (!release?.downloadUrl || !release?.version) throw new Error("No downloadable release is available");

      const fileName = release.fileName || "blacksite-vscode.vsix";

      document.querySelectorAll("[data-release-download]").forEach((link) => {
        link.href = release.downloadUrl;
        link.setAttribute("download", fileName);
        link.title = `Download ${fileName}`;
      });

      const detail = [
        `v${release.version}`,
        formatBytes(release.size),
        release.minimumVscodeVersion ? `VS Code ${release.minimumVscodeVersion}` : null,
      ].filter(Boolean).join(" · ");

      setText("[data-release-meta]", `${detail} · direct download`);
      setText("[data-release-button-label]", `Download v${release.version}`);
      setText("[data-install-file]", fileName);
      setText("[data-install-cmd]", `code --install-extension ${fileName}`);
    } catch {
      document.querySelectorAll("[data-release-download]").forEach((link) => { link.href = fallbackUrl; });
      setText("[data-release-meta]", "Latest release · direct VSIX download");
    }
  }

  void loadLatestRelease();
})();
