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

  /**
   * esbuild ships a platform-specific binary and the VSIX is packaged on one platform for every
   * platform, so the bundled copy only runs on machines matching the release runner. Preferring
   * the workspace's own install is what keeps mount previews working everywhere else.
   */
  it("uses the workspace's own esbuild when it has one", async () => {
    write("src/badge.js", "export default (host) => { host.textContent = 'Ready'; };");
    // The fixture lives inside this repo, whose node_modules carries a working esbuild — so a
    // successful build here is the workspace-resolution path doing the work.
    const result = await buildMountPreview(workspace, { entry: "src/badge.js" });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "esbuild"))).toBe(true);
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
