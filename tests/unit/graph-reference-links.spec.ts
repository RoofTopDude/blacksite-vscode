import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  linkReferenceText,
  normalizeRoute,
  ReferenceLinkIndex,
  routeProvidersFromEdges,
} from "../../src/graph/reference-links.js";
import { buildBasenameIndex } from "../../src/graph/resolve-imports.js";
import type { GraphEdge } from "../../src/graph/graph-model.js";

const files = new Set(["src/orders/handler.ts", "src/orders/model.ts", "src/users/model.ts", "web/api.ts"]);
const byBasename = buildBasenameIndex(files);
const apiEdges: GraphEdge[] = [
  { id: "a1", from: "web", to: "src", kind: "api", sourcePath: "web/api.ts", targetPath: "src/orders/handler.ts", label: "POST /api/orders/{id}" },
];

describe("reference → code links", () => {
  it("normalizes route parameter spellings", () => {
    expect(normalizeRoute("/API/orders/:orderId/")).toBe("/api/orders/*");
    expect(normalizeRoute("/api/orders/{id}")).toBe("/api/orders/*");
  });

  it("links a spec by path, unambiguous name, and API route", () => {
    const routes = routeProvidersFromEdges(apiEdges);
    const text = [
      "The order flow lives in `src/orders/model.ts`.",
      "Submitting calls POST /api/orders/:id and the handler validates it.",
      "Both services define a `model.ts`, so a bare mention is ambiguous.",
    ].join("\n");
    const targets = linkReferenceText(text, files, byBasename, routes);
    expect(targets.find((t) => t.path === "src/orders/model.ts")?.via).toBe("path");
    expect(targets.find((t) => t.path === "src/orders/handler.ts")?.via).toBe("route");
    expect(targets.some((t) => t.path === "src/users/model.ts")).toBe(false);
  });

  it("does not match a route when the method disagrees", () => {
    const targets = linkReferenceText("DELETE /api/orders/{id}", files, byBasename, routeProvidersFromEdges(apiEdges));
    expect(targets).toEqual([]);
  });

  it("indexes every conversation's text attachments and Extracted context, cached by mtime", () => {
    const root = mkdtempSync(join(tmpdir(), "bs-refs-"));
    try {
      const session = join(root, "s1");
      mkdirSync(session, { recursive: true });
      writeFileSync(join(session, "spec.md"), "See src/orders/handler.ts\n");
      writeFileSync(join(session, "diagram.png"), "binary");
      writeFileSync(join(session, "Extracted context.md"), "web/api.ts calls the orders service\n");
      let reads = 0;
      const store = {
        listSessions: () => ["s1"],
        listAttachments: () => {
          reads += 1;
          return [
            { name: "spec.md", path: join(session, "spec.md"), byteSize: 30 },
            { name: "diagram.png", path: join(session, "diagram.png"), byteSize: 6 },
          ];
        },
        contextMdPath: () => join(session, "Extracted context.md"),
        workspacePath: (abs: string) => abs.slice(root.length + 1).replace(/\\/g, "/"),
      };
      const index = new ReferenceLinkIndex(store);
      const links = index.links("g1", files, byBasename, []);
      expect(links.map((l) => l.name).sort()).toEqual(["Extracted context.md", "spec.md"]);
      expect(links.find((l) => l.name === "spec.md")!.targets[0]!.path).toBe("src/orders/handler.ts");

      writeFileSync(join(session, "spec.md"), "Now about src/users/model.ts\n");
      const later = new Date(Date.now() + 10_000);
      utimesSync(join(session, "spec.md"), later, later);
      const updated = index.links("g1", files, byBasename, []);
      expect(updated.find((l) => l.name === "spec.md")!.targets[0]!.path).toBe("src/users/model.ts");
      expect(reads).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
