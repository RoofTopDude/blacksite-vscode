import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The service tools attach a stored credential to every request, and the model supplies the
   path parts. These pin that a model value can only ever be one encoded path segment, and that
   a response which dies mid-body settles the call instead of leaving it pending forever. */

type Behaviour = "ok" | "reset";
const requests: Array<{ method: string; path: string; hostname: string }> = [];
let behaviour: Behaviour = "ok";

vi.mock("https", () => {
  const request = (options: { method: string; path: string; hostname: string }, onResponse: (res: EventEmitter) => void) => {
    requests.push({ method: options.method, path: options.path, hostname: options.hostname });
    const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; setTimeout: () => void };
    req.write = () => undefined;
    req.setTimeout = () => undefined;
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; complete: boolean; destroy: () => void };
      res.statusCode = 200;
      res.complete = false;
      res.destroy = () => undefined;
      onResponse(res);
      setImmediate(() => {
        res.emit("data", Buffer.from('{"partial":'));
        if (behaviour === "reset") {
          // A socket reset after the headers: Node emits an error and a close, never "end".
          res.emit("error", new Error("socket hang up"));
          res.emit("close");
          return;
        }
        res.emit("data", Buffer.from("true}"));
        res.complete = true;
        res.emit("end");
        res.emit("close");
      });
    };
    return req;
  };
  return { default: { request } };
});

const { handleGithub, handleGitlab, handleJira } = await import("../../packages/local-runtime/src/service-tools.js");

beforeEach(() => {
  requests.length = 0;
  behaviour = "ok";
});

describe("service tools — model-supplied path parts", () => {
  it("encodes a traversal attempt into a single inert segment", async () => {
    await handleGithub("t", { op: "add_comment", owner: "o", repo: "r", number: "../../../../user/keys", body: "x" });
    expect(requests[0]).toMatchObject({ method: "POST", path: "/repos/o/r/issues/..%2F..%2F..%2F..%2Fuser%2Fkeys/comments" });
  });

  it("refuses a bare dot segment, which URL parsing would collapse", async () => {
    await expect(handleGithub("t", { op: "get_issue", owner: "o", repo: "..", number: "1" })).rejects.toThrow(/Invalid repo/);
    await expect(handleJira("e", "t", { op: "update_issue", host: "https://jira.example.com", key: ".", fields: {} }))
      .rejects.toThrow(/Invalid key/);
    await expect(handleGithub("t", { op: "get_file", owner: "o", repo: "r", path: "docs/../../../user" }))
      .rejects.toThrow(/Invalid path/);
    expect(requests).toHaveLength(0);
  });

  it("names a missing repository instead of requesting /repos///", async () => {
    await expect(handleGithub("t", { op: "list_issues" })).rejects.toThrow(/Missing owner/);
  });

  it("keeps ordinary values unchanged", async () => {
    await handleGithub("t", { op: "get_file", owner: "o", repo: "r", path: "src/index.ts", ref: "feature/x" });
    await handleGithub("t", { op: "list_issues", owner: "o", repo: "r", state: "closed", limit: "not a number" });
    await handleGitlab("t", { op: "get_mr", host: "https://gitlab.example.com", projectId: "group/project", iid: 7 });
    expect(requests.map((request) => request.path)).toEqual([
      "/repos/o/r/contents/src/index.ts?ref=feature%2Fx",
      "/repos/o/r/issues?state=closed&per_page=30",
      "/api/v4/projects/group%2Fproject/merge_requests/7",
    ]);
  });

  it("still searches without a repository", async () => {
    await handleGithub("t", { op: "search_code", query: "repo:o/r needle" });
    expect(requests[0]?.path).toBe("/search/code?q=repo%3Ao%2Fr%20needle&per_page=20");
  });
});

describe("service tools — response failures", () => {
  it("rejects when the connection dies mid-body instead of hanging", async () => {
    behaviour = "reset";
    const outcome = await Promise.race([
      handleGithub("t", { op: "get_issue", owner: "o", repo: "r", number: "1" }).then(() => "resolved", (error: Error) => error.message),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
    ]);
    expect(outcome).toBe("socket hang up");
  });

  it("returns a normal response unchanged", async () => {
    await expect(handleGithub("t", { op: "get_issue", owner: "o", repo: "r", number: "1" }))
      .resolves.toEqual({ ok: true, statusCode: 200, data: { partial: true } });
  });
});
