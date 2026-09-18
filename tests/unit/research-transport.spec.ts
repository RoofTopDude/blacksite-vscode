import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { PinnedResearchTransport } from "../../src/browser/research-transport.js";

describe("DNS-pinned HTTPS transport", () => {
  it("blocks the whole DNS answer set if any address is nonpublic, before opening a connection", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(new PinnedResearchTransport().get(new URL("https://example.com"), {})).rejects.toThrow(/private or nonpublic/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("pins connection lookup to the validated answer while preserving SNI and certificate hostname", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    mocks.request.mockImplementation((url, options, callback) => {
      expect(url.hostname).toBe("example.com"); expect(options.servername).toBe("example.com"); expect(options.agent).toBe(false);
      const cb = vi.fn(); options.lookup("example.com", { all: false }, cb);
      expect(cb).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      const all = vi.fn(); options.lookup("example.com", { all: true }, all);
      expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200 });
        callback(res); res.emit("data", Buffer.from("ok")); res.emit("end");
      };
      return req;
    });
    expect(await new PinnedResearchTransport().get(new URL("https://example.com"), {})).toMatchObject({ status: 200, body: Buffer.from("ok") });
    expect(mocks.lookup).toHaveBeenCalledOnce();
  });
  it("does not open a connection after cancellation during resolution", async () => {
    const controller = new AbortController();
    mocks.lookup.mockImplementation(async () => { controller.abort(); return [{ address: "8.8.8.8", family: 4 }]; });
    await expect(new PinnedResearchTransport().get(new URL("https://example.com"), {}, controller.signal)).rejects.toThrow(/cancelled/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
