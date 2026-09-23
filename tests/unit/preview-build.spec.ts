/**
 * Building a preview out of the project's real component source.
 *
 * A hand-reimplemented preview is a parallel artefact that can drift from the thing it claims to
 * depict, invisibly — which is why previews read as loose representations rather than as the
 * change. Mounting the real component under an in-memory patch removes the gap entirely: the
 * preview is the component, and the patch is the implementation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildCodePreview, buildMountPreview } from "../../src/preview-build.js";

/**
 * The fixture workspace lives inside the repo so esbuild's upward node_modules walk finds the real
 * react — a temp dir elsewhere on disk cannot resolve it, and the React path is the one that most
 * needs covering.
 */
const repoRoot = path.resolve(__dirname, "..", "..");
const workspace = path.join(repoRoot, ".tmp-preview-build-test");

function write(relative: string, contents: string): void {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function writeBinary(relative: string, contents: Buffer): void {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(workspace, relative), "utf8");
}

beforeAll(() => {
  fs.mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

afterEach(() => {
  for (const entry of fs.readdirSync(workspace)) {
    fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
  }
});

describe("buildMountPreview", () => {
  it("bundles a plain DOM component from the workspace", async () => {
    write("src/badge.js", "export default function mount(host){ host.textContent = 'Ready'; }");
    const result = await buildMountPreview(workspace, { entry: "src/badge.js" });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("Ready");
    expect(result.code).toContain("document.body.appendChild");
  });

  it("renders a React component through react-dom", async () => {
    write("src/Button.tsx", "export function Button({ label }: { label: string }) { return <button>{label}</button>; }");
    const result = await buildMountPreview(workspace, {
      entry: "src/Button.tsx",
      export: "Button",
      props: { label: "Save changes" },
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("Save changes");
    // Proof the real react-dom was bundled rather than the harness being emitted on its own.
    expect((result.code ?? "").length).toBeGreaterThan(10_000);
  });

  it("passes props through, so the preview shows representative content", async () => {
    write("src/label.js", "export default (host, props) => { host.textContent = props.text; };");
    const result = await buildMountPreview(workspace, { entry: "src/label.js", props: { text: "Fourteen items" } });
    expect(result.code).toContain("Fourteen items");
  });

  /** The whole point: the preview reflects the proposed edit without touching the working tree. */
  it("applies a patch in memory and leaves the file on disk untouched", async () => {
    write("src/card.js", "export default (host) => { host.style.borderRadius = '4px'; };");
    const result = await buildMountPreview(workspace, {
      entry: "src/card.js",
      patch: [{ file: "src/card.js", find: "'4px'", replace: "'12px'" }],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("12px");
    expect(result.code).not.toContain("4px");
    expect(read("src/card.js")).toContain("'4px'");
    expect(result.patchedFiles).toEqual(["src/card.js"]);
  });

  it("patches a dependency of the entry, not just the entry itself", async () => {
    write("src/tokens.js", "export const GAP = '2px';");
    write("src/row.js", "import { GAP } from './tokens.js'; export default (host) => { host.style.gap = GAP; };");
    const result = await buildMountPreview(workspace, {
      entry: "src/row.js",
      patch: [{ file: "src/tokens.js", find: "'2px'", replace: "'10px'" }],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("10px");
  });

  it("applies several patches to one file in sequence", async () => {
    write("src/multi.js", "export default (h) => { h.dataset.a = 'one'; h.dataset.b = 'two'; };");
    const result = await buildMountPreview(workspace, {
      entry: "src/multi.js",
      patch: [
        { file: "src/multi.js", find: "'one'", replace: "'ONE'" },
        { file: "src/multi.js", find: "'two'", replace: "'TWO'" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("ONE");
    expect(result.code).toContain("TWO");
  });

  /**
   * Rendering a preview whose patch silently did not apply is the worst possible outcome: it looks
   * like a successful depiction of a change it does not contain.
   */
  it("fails loudly when `find` does not match", async () => {
    write("src/card.js", "export default (host) => { host.id = 'card'; };");
    const result = await buildMountPreview(workspace, {
      entry: "src/card.js",
      patch: [{ file: "src/card.js", find: "not-present", replace: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not apply");
  });

  it("refuses an ambiguous single-shot patch rather than guessing which occurrence was meant", async () => {
    write("src/twice.js", "export default (h) => { h.a = 'x'; h.b = 'x'; };");
    const result = await buildMountPreview(workspace, {
      entry: "src/twice.js",
      patch: [{ file: "src/twice.js", find: "'x'", replace: "'y'" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exactly once");
  });

  it("replaces every occurrence when `all` is set", async () => {
    write("src/twice.js", "export default (h) => { h.a = 'x'; h.b = 'x'; };");
    const result = await buildMountPreview(workspace, {
      entry: "src/twice.js",
      patch: [{ file: "src/twice.js", find: "'x'", replace: "'y'", all: true }],
    });
    expect(result.ok).toBe(true);
    expect(result.code).not.toContain("'x'");
  });

  /** A preview build reads and compiles arbitrary files; the workspace boundary is the only thing
   *  between a malformed tool call and the rest of the disk. */
  it("rejects an entry outside the workspace", async () => {
    const result = await buildMountPreview(workspace, { entry: "../../../etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the workspace");
  });

  it("rejects a patch target outside the workspace", async () => {
    write("src/ok.js", "export default () => {};");
    const result = await buildMountPreview(workspace, {
      entry: "src/ok.js",
      patch: [{ file: "../../secrets.env", find: "a", replace: "b" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the workspace");
  });

  it("reports a missing entry as a correctable error", async () => {
    const result = await buildMountPreview(workspace, { entry: "src/nope.tsx" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("reports a compile error instead of throwing", async () => {
    write("src/broken.js", "export default (host) => { this is not javascript };");
    const result = await buildMountPreview(workspace, { entry: "src/broken.js" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Preview build failed");
  });

  it("requires a workspace", async () => {
    const result = await buildMountPreview("", { entry: "src/a.js" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("workspace");
  });

  /** Component-level CSS imports have to reach the preview document, or a mounted component
   *  renders without the styles it ships with. */
  it("returns CSS imported by the component so it can be injected alongside the project sheet", async () => {
    write("src/styles.css", ".mounted-card { border-radius: 11px; }");
    write("src/styled.js", "import './styles.css'; export default (host) => { host.className = 'mounted-card'; };");
    const result = await buildMountPreview(workspace, { entry: "src/styled.js" });
    expect(result.ok).toBe(true);
    expect(result.css).toMatch(/border-radius:\s*11px/);
  });

  it("inlines imported visual assets so mounted previews remain self-contained", async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    writeBinary("src/hero.png", bytes);
    write("src/visual.js", "import hero from './hero.png'; export default (host) => { const image = new Image(); image.src = hero; host.append(image); };");
    const result = await buildMountPreview(workspace, { entry: "src/visual.js" });
    expect(result.ok).toBe(true);
    expect(result.code).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
  });

  it("bundles authored GPU shader sources as text", async () => {
    write("src/material.wgsl", "@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }");
    write("src/shader.js", "import shader from './material.wgsl'; export default (host) => { host.dataset.shader = shader; };");
    const result = await buildMountPreview(workspace, { entry: "src/shader.js" });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("@fragment fn main()");
  });

  it("mounts the default export when no export name is given", async () => {
    write("src/default.js", "export default (host) => { host.textContent = 'from default'; };");
    const result = await buildMountPreview(workspace, { entry: "src/default.js" });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("from default");
  });

  /** A native workspace copy stays the fast path; the following test covers the portable VSIX
   * fallback that release packaging uses for macOS and every other platform. */
  it("uses the workspace's own esbuild when it has one", async () => {
    write("src/badge.js", "export default (host) => { host.textContent = 'Ready'; };");
    // The fixture lives inside this repo, whose node_modules carries a working esbuild — so a
    // successful build here is the workspace-resolution path doing the work.
    const result = await buildMountPreview(workspace, { entry: "src/badge.js" });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "esbuild"))).toBe(true);
  });

  /**
   * esbuild-wasm starts its service as `node <script>` looked up on PATH. With no Node.js there —
   * no install at all, or macOS with Node under nvm/Homebrew and VS Code launched from the Dock —
   * every mount and workspace code preview failed. The service is spawned once per process, on
   * first use, so this must stay the first WASM build in this file for PATH to matter.
   */
  it("uses the portable WASM bundler when the workspace has no native esbuild, even with no Node.js on PATH", async () => {
    const portableWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "bls-preview-wasm-"));
    const savedPath = process.env["PATH"];
    const savedWindowsPath = process.env["Path"];
    try {
      const entry = path.join(portableWorkspace, "preview.js");
      fs.writeFileSync(entry, "export default (host) => { host.textContent = 'portable preview'; };", "utf8");
      process.env["PATH"] = "";
      if (savedWindowsPath !== undefined) process.env["Path"] = "";
      const result = await buildMountPreview(portableWorkspace, { entry: "preview.js", renderer: "dom" });
      expect(result).toMatchObject({ ok: true });
      expect(result.code).toContain("portable preview");
    } finally {
      process.env["PATH"] = savedPath;
      if (savedWindowsPath !== undefined) process.env["Path"] = savedWindowsPath;
      fs.rmSync(portableWorkspace, { recursive: true, force: true });
    }
  });

  /** A patch to a file the entry never imports used to build "successfully" and render the
   *  unmodified component — a preview that silently did not contain its own proposal. */
  it("fails when a patch targets a file the entry does not import", async () => {
    write("src/card.js", "export default (host) => { host.textContent = 'card'; };");
    write("src/unrelated.js", "export const tone = 'quiet';");
    const result = await buildMountPreview(workspace, {
      entry: "src/card.js",
      patch: [{ file: "src/unrelated.js", find: "quiet", replace: "loud" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/src\/unrelated\.js.*not applied.*not imported by "src\/card\.js"/s);
  });

  it("builds an unpatched mount, which is how a comparison shows the 'keep it as-is' option", async () => {
    write("src/as-is.js", "export default (host) => { host.textContent = 'current'; };");
    const result = await buildMountPreview(workspace, { entry: "src/as-is.js" });
    expect(result.ok).toBe(true);
    expect(result.patchedFiles).toEqual([]);
  });
});

describe("buildCodePreview", () => {
  it("bundles an installed package from a monorepo app dependency context", async () => {
    write("apps/web/node_modules/preview-kit/package.json", JSON.stringify({
      name: "preview-kit", version: "1.0.0", type: "module", exports: "./index.js",
    }));
    write("apps/web/node_modules/preview-kit/index.js", "export const message = 'package resolved';");
    const result = await buildCodePreview(workspace, {
      code: "import { message } from 'preview-kit'; document.body.textContent = message;",
      resolveFrom: "apps/web",
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("package resolved");
    expect(result.code).not.toContain("from \"preview-kit\"");
  });

  it("bundles relative modules and their imported CSS", async () => {
    write("packages/scene/label.ts", "export const label: string = 'local module';");
    write("packages/scene/scene.css", ".scene { perspective: 800px; }");
    const result = await buildCodePreview(workspace, {
      code: "import { label } from './label'; import './scene.css'; document.body.textContent = label;",
      resolveFrom: "packages/scene",
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("local module");
    expect(result.css).toMatch(/perspective:\s*800px/);
  });

  it("accepts a file as the monorepo import context", async () => {
    write("apps/editor/package.json", "{}");
    write("apps/editor/visual.js", "export const visual = 'from file context';");
    const result = await buildCodePreview(workspace, {
      code: "import { visual } from './visual.js'; document.body.textContent = visual;",
      resolveFrom: "apps/editor/package.json",
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("from file context");
  });

  it("rejects an import context outside the workspace", async () => {
    const result = await buildCodePreview(workspace, { code: "import 'anything';", resolveFrom: "../outside" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the workspace");
  });

  it("returns an actionable error for an uninstalled package", async () => {
    const result = await buildCodePreview(workspace, {
      code: "import { missing } from 'definitely-not-installed-preview-package'; document.body.textContent = missing;",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("definitely-not-installed-preview-package");
    expect(result.error).toContain("resolveFrom");
    expect(result.error).toMatch(/already be installed/i);
  });

  it("keeps self-contained code usable when no workspace is open", async () => {
    const code = "document.body.textContent = 'self-contained';";
    expect(await buildCodePreview("", { code })).toMatchObject({ ok: true, code });
  });

  it("explains that imports need a workspace when none is open", async () => {
    const result = await buildCodePreview("", { code: "const later = import('thing');" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workspace/i);
  });

  it("rejects a bundle large enough to destabilize the VS Code renderer", async () => {
    const result = await buildCodePreview(workspace, {
      code: `document.body.dataset.payload=${JSON.stringify("x".repeat(4 * 1024 * 1024 + 32))};`,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/4 MB sandbox budget/i);
    expect(result.error).toMatch(/renderer memory/i);
  });
});

describe("preview builds in a project without React", () => {
  /** Outside the repo, so the upward node_modules walk cannot find the repo's own React — the
   *  situation of a game, CLI or plain-DOM project that never installed it. */
  let bare: string;

  beforeAll(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "bls-preview-no-react-"));
    fs.writeFileSync(path.join(bare, "package.json"), "{}");
  });

  afterAll(() => {
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it("builds JSX with the bundled React instead of rejecting the preview", async () => {
    const result = await buildCodePreview(bare, {
      code: "import { useState } from 'react';\nimport { createRoot } from 'react-dom/client';\n"
        + "function App() { const [n] = useState(3); return <div>count {n}</div>; }\n"
        + "createRoot(document.body.appendChild(document.createElement('div'))).render(<App />);",
    });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("count ");
    expect(result.warnings?.join(" ")).toMatch(/React runtime bundled with Blacksite/);
  });

  it("builds bare JSX, which imports react/jsx-runtime implicitly", async () => {
    const result = await buildCodePreview(bare, { code: "document.body.append(String(<b>x</b>));" });
    expect(result.ok).toBe(true);
  });

  it("does not mention React for plain DOM code", async () => {
    const result = await buildCodePreview(bare, { code: "document.body.textContent = 'plain';" });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it("mounts a React component from a project that has no React installed", async () => {
    fs.mkdirSync(path.join(bare, "src"), { recursive: true });
    fs.writeFileSync(path.join(bare, "src", "Card.jsx"), "export function Card({ title }) { return <h2>{title}</h2>; }");
    const result = await buildMountPreview(bare, { entry: "src/Card.jsx", export: "Card", props: { title: "Hi" } });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(" ")).toMatch(/React runtime bundled with Blacksite/);
  });
});

describe("preview build errors the agent can act on", () => {
  it("points a syntax error at the line and text in `code`, not at packages", async () => {
    const result = await buildCodePreview(workspace, { code: "const ok = 1;\nconst s = { margin-top: 4 };" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("code:2:");
    expect(result.error).toContain("near: const s = { margin-top: 4 };");
    expect(result.error).toMatch(/must be quoted/);
    expect(result.error).not.toMatch(/already be installed/i);
  });

  it("trims the excerpt around the error on a long single-line preview", async () => {
    const result = await buildCodePreview(workspace, { code: `${Array.from({ length: 40 }, (_, i) => `let a${i} = ${i};`).join(" ")} const s = { margin-top: 4 };` });
    expect(result.error).toMatch(/near: …/);
    expect(result.error).toContain("margin-top");
  });

  it("names the file and line for a compile error in a mounted component", async () => {
    write("src/broken.js", "export default (host) => { this is not javascript };");
    const result = await buildMountPreview(workspace, { entry: "src/broken.js" });
    expect(result.error).toMatch(/broken\.js:1:\d+/);
  });

  it("builds a named-export mount without a spurious missing-default warning", async () => {
    write("src/named.js", "export function mount(host) { host.textContent = 'named'; }");
    const result = await buildMountPreview(workspace, { entry: "src/named.js", export: "mount", renderer: "dom" });
    expect(result.ok).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("lists the entry's real exports when the requested one does not exist", async () => {
    write("src/named.js", "export function mount(host) { host.textContent = 'named'; }");
    const result = await buildMountPreview(workspace, { entry: "src/named.js", export: "Mount", renderer: "dom" });
    expect(result.ok).toBe(true);
    expect(result.code).toContain("exports: ");
  });
});
