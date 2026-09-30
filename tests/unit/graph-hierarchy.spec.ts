import { describe, expect, it } from "vitest";
import { buildHierarchy, groupId } from "../../src/graph/hierarchy.js";
import { buildProjectTopology } from "../../src/graph/project-topology.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";

function node(id: string, codebase: string, dir: string, x = 0, y = 0): GraphNode {
  return { id, dir, lang: id.split(".").pop()!, sizeBytes: 10, inDegree: 0, outDegree: 0, x, y, z: 0.2, codebase };
}
const imp = (from: string, to: string): GraphEdge => ({ id: `imp:${from}->${to}`, from, to, kind: "import" });

/* Two workspace folders; `front` is a pnpm monorepo with two packages. */
const topology = buildProjectTopology([
  { path: "front/package.json", content: JSON.stringify({ name: "front", workspaces: ["packages/*"] }) },
  { path: "front/packages/ui/package.json", content: JSON.stringify({ name: "@f/ui" }) },
  { path: "front/packages/app/package.json", content: JSON.stringify({ name: "@f/app", dependencies: { "@f/ui": "*", "@f/unused": "*" } }) },
  { path: "front/packages/unused/package.json", content: JSON.stringify({ name: "@f/unused" }) },
  { path: "back/package.json", content: JSON.stringify({ name: "back" }) },
]);

const nodes = [
  node("front/packages/app/src/main.ts", "front", "front/packages/app/src", 0, 0),
  node("front/packages/app/src/view.ts", "front", "front/packages/app/src", 10, 0),
  node("front/packages/ui/src/button.ts", "front", "front/packages/ui/src", 50, 0),
  node("front/packages/unused/src/x.ts", "front", "front/packages/unused/src", 90, 0),
  node("back/src/server.ts", "back", "back/src", 400, 0),
  node("back/src/db.ts", "back", "back/src", 420, 0),
];

describe("buildHierarchy", () => {
  const hierarchy = buildHierarchy({
    nodes,
    renderedIds: new Set(nodes.slice(0, 4).map((n) => n.id)),
    rootNames: ["front", "back"],
    topology,
    importEdges: [
      imp("front/packages/app/src/main.ts", "front/packages/ui/src/button.ts"),
      imp("front/packages/app/src/main.ts", "front/packages/app/src/view.ts"),
      imp("back/src/server.ts", "back/src/db.ts"),
      /* An app file reaching into back's source with no manifest reference. */
      imp("front/packages/app/src/view.ts", "back/src/db.ts"),
    ],
    serviceEdges: [{
      id: "api:1", from: "x", to: "y", kind: "api", sourcePath: "front/packages/app/src/view.ts", targetPath: "back/src/server.ts",
      label: "GET /api/orders", confidence: 0.9,
    }],
    cochangeEdges: [
      { id: "c1", from: "front/packages/unused/src/x.ts", to: "back/src/db.ts", kind: "cochange", confidence: 0.8 },
    ],
  });
  const byId = new Map(hierarchy.groups.map((g) => [g.id, g]));

  it("builds root → project → area groups with true counts", () => {
    expect(hierarchy.roots).toEqual(["front", "back"]);
    const front = byId.get(groupId("root", "front"))!;
    expect(front.fileCount).toBe(4);
    expect(front.renderedCount).toBe(4);
    expect(byId.get(groupId("root", "back"))!.renderedCount).toBe(0);
    /* `front` holds several packages, so each gets a project group. */
    const app = byId.get(groupId("project", "front/packages/app"))!;
    expect(app.parent).toBe(groupId("root", "front"));
    expect(app.fileCount).toBe(2);
    expect(byId.get(groupId("area", "front/packages/app/src"))!.parent).toBe(app.id);
    /* A codebase that is the whole folder is represented by the root itself. */
    expect(byId.has(groupId("codebase", "front"))).toBe(false);
  });

  it("aggregates import and route relationships between groups", () => {
    const rootEdges = hierarchy.edges.filter((e) => e.level === "root");
    expect(rootEdges.find((e) => e.kind === "import" && e.from === groupId("root", "front") && e.to === groupId("root", "back"))?.count).toBe(1);
    expect(rootEdges.find((e) => e.kind === "api")?.evidence).toEqual(["GET /api/orders"]);
    expect(hierarchy.edges.find((e) => e.kind === "project_ref" && e.from === groupId("project", "front/packages/app") && e.to === groupId("project", "front/packages/ui"))).toBeTruthy();
  });

  it("compares declared dependencies with actual imports", () => {
    expect(hierarchy.declaredUnused.map((f) => `${f.fromName}->${f.toName}`)).toContain("@f/app->@f/unused");
    expect(hierarchy.declaredUnused.map((f) => `${f.fromName}->${f.toName}`)).not.toContain("@f/app->@f/ui");
    expect(hierarchy.usedUndeclared.map((f) => `${f.fromName}->${f.toName}`)).toContain("@f/app->back");
  });

  it("aggregates a Systems level that mixes codebase and folder groups", () => {
    const sys = hierarchy.edges.filter((e) => e.level === "systems");
    expect(sys.find((e) => e.kind === "import" && e.from === groupId("root", "front") && e.to === groupId("root", "back"))?.count).toBe(1);
    expect(sys.every((e) => e.id.startsWith("grp:sys:"))).toBe(true);
  });

  it("flags co-change that no structural link explains as hidden coupling", () => {
    const coupling = hierarchy.edges.find((e) => e.kind === "cochange" && e.level === "project");
    expect(coupling).toBeUndefined(); // back has no project group (one project in its codebase)
    const rootCoupling = hierarchy.edges.find((e) => e.kind === "cochange" && e.level === "root")!;
    /* front→back is explained by an import at root level. */
    expect(rootCoupling.unexplained).toBeFalsy();
  });

  it("positions groups at their members' centroid with a covering radius", () => {
    const back = byId.get(groupId("root", "back"))!;
    expect(back.x).toBe(410);
    expect(back.radius).toBe(10);
  });
});
