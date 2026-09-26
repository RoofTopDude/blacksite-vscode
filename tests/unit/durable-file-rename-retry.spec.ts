import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* A rename over a file another process briefly holds open fails transiently (EBUSY anywhere,
   EPERM/EACCES on Windows). The save must ride that out instead of failing the store write. */

const failures: string[] = [];

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const code = failures.shift();
      if (code) throw Object.assign(new Error(`${code}: simulated`), { code });
      actual.renameSync(from, to);
    },
  };
});

const fs = await import("fs");
const os = await import("os");
const path = await import("path");
const { atomicWriteFile } = await import("../../src/shared/durable-file.js");

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-rename-retry-")); });
afterEach(() => {
  failures.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("atomicWriteFile — transient rename failures", () => {
  it("retries a busy target and lands the new document", () => {
    const target = path.join(root, "doc.json");
    atomicWriteFile(target, "old");
    failures.push("EBUSY", "EBUSY");
    atomicWriteFile(target, "new");
    expect(fs.readFileSync(target, "utf8")).toBe("new");
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("gives up after the bounded retries and cleans up the temp file", () => {
    const target = path.join(root, "doc.json");
    atomicWriteFile(target, "old");
    failures.push(...Array.from({ length: 10 }, () => "EBUSY"));
    expect(() => atomicWriteFile(target, "new")).toThrow(/EBUSY/);
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not retry a failure that is not transient", () => {
    const target = path.join(root, "doc.json");
    failures.push("ENOSPC", "ENOSPC");
    expect(() => atomicWriteFile(target, "x")).toThrow(/ENOSPC/);
    expect(failures).toEqual(["ENOSPC"]);
  });
});
