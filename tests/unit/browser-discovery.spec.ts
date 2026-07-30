import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRunner } from "../../src/chromium-runner";
import { discoverBrowserSurfaces } from "../../src/sequences/browser-discovery";

function write(root: string, relative: string, content = "export {};"): void {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("discoverBrowserSurfaces", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-discovery-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recognizes route conventions, stories, tests, and router declarations", async () => {
    write(root, "src/app/page.tsx");
    write(root, "src/app/(account)/settings/[id]/page.tsx");
    write(root, "pages/docs/[...slug].tsx");
    write(root, "pages/api/secret.ts");
    write(root, "src/routes/(account)/profile/[user]/+page.svelte");
    write(root, "src/router.tsx", `
      const routes = [{ path: "/settings" }, { path: "/router-only" }];
      export const view = <Route path="/jsx-route" />;
    `);
    write(root, "src/Button.stories.tsx", `
      export default { title: "Forms/Button" };
    `);
    write(root, "e2e/login.spec.ts", "test('login', () => {});");

    const result = await discoverBrowserSurfaces(root, {
      entrypoint: "http://localhost:4173/base",
      include: ["routes", "stories", "tests"],
    });
    const byId = new Map(result.surfaces.map((surface) => [surface.id, surface]));

    expect([...byId.keys()]).toEqual(expect.arrayContaining([
      "route:/",
      "route:/settings/:id",
      "route:/docs/:slug",
      "route:/profile/:user",
      "route:/router-only",
      "route:/jsx-route",
      "story:Forms/Button",
      "test:e2e/login.spec.ts",
    ]));
    expect([...byId.keys()]).not.toContain("route:/api/secret");
    expect(byId.get("route:/settings/:id")).toMatchObject({
      source: "filesystem",
      confidence: 0.96,
      url: "http://localhost:4173/settings/:id",
      entityRef: {
        scheme: "route",
        id: "/settings/:id",
        workspacePath: "src/app/(account)/settings/[id]/page.tsx",
      },
    });
    expect(byId.get("route:/settings")?.source).toBe("router");
    expect(byId.get("story:Forms/Button")).toMatchObject({
      label: "Forms/Button",
      path: "src/Button.stories.tsx",
    });
    expect(result.coverage).toMatchObject({
      scannedFiles: 8,
      truncatedScan: false,
    });
  });

  it("uses an opaque continuation cursor without overlapping pages", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      write(root, `src/app/${name}/page.tsx`);
    }

    const first = await discoverBrowserSurfaces(root, {
      sources: ["filesystem"],
      include: ["routes"],
      limit: 2,
    });
    const second = await discoverBrowserSurfaces(root, {
      sources: ["filesystem"],
      include: ["routes"],
      limit: 2,
      cursor: first.nextCursor,
    });
    const last = await discoverBrowserSurfaces(root, {
      sources: ["filesystem"],
      include: ["routes"],
      limit: 2,
      cursor: second.nextCursor,
    });

    expect(first.matched).toBe(5);
    expect(first.surfaces).toHaveLength(2);
    expect(second.surfaces).toHaveLength(2);
    expect(last.surfaces).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect(new Set([
      ...first.surfaces,
      ...second.surfaces,
      ...last.surfaces,
    ].map((surface) => surface.id)).size).toBe(5);
  });

  it("adds same-origin runtime links, strips queries, and ignores external links", async () => {
    const dispatch = vi.fn(async (toolType: string) => {
      if (toolType === "navigate") return { ok: true };
      if (toolType === "evaluate") {
        return {
          ok: true,
          result: [
            { href: "http://localhost:4173/account?token=secret#profile", label: "Account" },
            { href: "/account?other=value", label: "Duplicate" },
            { href: "/help", label: "" },
            { href: "https://example.com/leave", label: "External" },
          ],
        };
      }
      return { ok: false };
    });
    const browser: BrowserRunner = {
      dispatch,
      async dispose() {},
    };

    const result = await discoverBrowserSurfaces(root, {
      entrypoint: "http://localhost:4173/",
      sources: ["runtime"],
      include: ["routes"],
    }, browser);

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "navigate",
      { url: "http://localhost:4173/", waitFor: "load" },
      undefined,
      {
        allowedOrigins: ["http://localhost:4173"],
        localOnly: true,
      },
    );
    expect(result.surfaces).toHaveLength(2);
    expect(result.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "route:/account",
        label: "Account",
        source: "runtime",
        url: "http://localhost:4173/account",
        reachable: true,
      }),
      expect.objectContaining({
        id: "route:/help",
        label: "/help",
        source: "runtime",
        url: "http://localhost:4173/help",
        reachable: true,
      }),
    ]));
  });

  it("merges runtime reachability into a higher-confidence conventional route", async () => {
    write(root, "src/app/account/page.tsx");
    const browser: BrowserRunner = {
      dispatch: vi.fn(async (toolType: string) => (
        toolType === "navigate"
          ? { ok: true }
          : { ok: true, result: [{ href: "/account", label: "Account" }] }
      )),
      async dispose() {},
    };

    const result = await discoverBrowserSurfaces(root, {
      entrypoint: "http://localhost:4173/",
      sources: ["filesystem", "runtime"],
      include: ["routes"],
    }, browser);

    expect(result.surfaces).toMatchObject([{
      id: "route:/account",
      source: "filesystem",
      confidence: 0.96,
      reachable: true,
      url: "http://localhost:4173/account",
    }]);
  });

  it("does not drive a browser for remote entrypoints", async () => {
    const browser: BrowserRunner = {
      dispatch: vi.fn(),
      async dispose() {},
    };

    const result = await discoverBrowserSurfaces(root, {
      entrypoint: "https://example.com",
      sources: ["runtime"],
      include: ["routes"],
    }, browser);

    expect(browser.dispatch).not.toHaveBeenCalled();
    expect(result.surfaces).toEqual([]);
  });

  it("treats IPv6 loopback as a local runtime entrypoint", async () => {
    const browser: BrowserRunner = {
      dispatch: vi.fn(async (toolType: string) => (
        toolType === "navigate"
          ? { ok: true }
          : { ok: true, result: [{ href: "/ipv6", label: "IPv6" }] }
      )),
      async dispose() {},
    };

    const result = await discoverBrowserSurfaces(root, {
      entrypoint: "http://[::1]:4173/",
      sources: ["runtime"],
      include: ["routes"],
    }, browser);

    expect(browser.dispatch).toHaveBeenCalled();
    expect(result.surfaces).toMatchObject([{ id: "route:/ipv6", reachable: true }]);
  });
});
