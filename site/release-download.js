(() => {
  const fallbackUrl = "https://github.com/RoofTopDude/blacksite-vscode/releases/latest";
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  async function loadLatestRelease() {
    try {
      const response = await fetch("latest.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`latest.json returned ${response.status}`);
      const release = await response.json();
      if (!release?.downloadUrl || !release?.version) throw new Error("No downloadable release is available");

      document.querySelectorAll("[data-release-download]").forEach((link) => {
        link.href = release.downloadUrl;
        link.setAttribute("download", release.fileName || "blacksite-vscode.vsix");
        link.title = `Download ${release.fileName || `Blacksite v${release.version}`}`;
      });

      const detail = [
        `v${release.version}`,
        formatBytes(release.size),
        release.minimumVscodeVersion ? `VS Code ${release.minimumVscodeVersion}` : null,
      ].filter(Boolean).join(" · ");
      document.querySelectorAll("[data-release-meta]").forEach((node) => { node.textContent = `${detail} · direct download`; });
      document.querySelectorAll("[data-release-button-label]").forEach((node) => { node.textContent = `Download v${release.version}`; });
      document.querySelectorAll("[data-release-install-note]").forEach((node) => {
        const fileName = release.fileName || "blacksite-vscode.vsix";
        const fileCode = document.createElement("code");
        const commandCode = document.createElement("code");
        fileCode.textContent = fileName;
        commandCode.textContent = `code --install-extension ${fileName}`;
        node.replaceChildren("Direct download: ", fileCode, " · then run ", commandCode, ".");
      });
    } catch {
      document.querySelectorAll("[data-release-download]").forEach((link) => { link.href = fallbackUrl; });
      document.querySelectorAll("[data-release-meta]").forEach((node) => { node.textContent = "Latest release · direct VSIX download"; });
    }
  }

  void loadLatestRelease();
})();
