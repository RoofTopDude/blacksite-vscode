import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunArtifactStore } from "../../src/runs/run-artifact-store";

describe("RunArtifactStore", () => {
  let root: string;
  let store: RunArtifactStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-artifacts-"));
    store = new RunArtifactStore(root).ensureInitialized();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stores blobs by SHA-256 and returns the original bytes", () => {
    const content = Buffer.from("pixel bytes");
    const expected = createHash("sha256").update(content).digest("hex");
    const artifact = store.put(content);

    expect(artifact).toMatchObject({
      id: expected,
      sha256: expected,
      byteLength: content.byteLength,
      created: true,
    });
    expect(artifact.path).toBe(path.join(
      root,
      ".blacksite",
      "runs",
      "artifacts",
      "sha256",
      expected.slice(0, 2),
      expected,
    ));
    expect(store.read(expected)).toEqual(content);
  });

  it("deduplicates equal content across repeated writes", () => {
    const first = store.put("same");
    const second = store.put(Buffer.from("same"));
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(fs.readdirSync(path.dirname(first.path))).toEqual([first.id]);
  });

  it("rejects artifact ids that could escape the content-addressed root", () => {
    expect(() => store.path("../../outside")).toThrow(/invalid sha-256 artifact id/i);
  });

  it("reports a missing well-formed artifact without throwing", () => {
    expect(store.get("0".repeat(64))).toBeUndefined();
  });
});
