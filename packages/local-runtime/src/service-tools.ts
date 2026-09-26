import https from "https";

const SERVICE_TIMEOUT_MS = 30_000;
const MAX_SERVICE_RESPONSE_BYTES = 10 * 1024 * 1024;

// ── Generic HTTP helper ────────────────────────────────────────────────────────

interface HttpResponse { statusCode: number; body: string }

/** Credential-bearing integrations accept an origin selected in application-scoped settings,
 * never an arbitrary model-authored URL. HTTPS and credential-free origins are mandatory. */
export function normalizeServiceOrigin(input: string, label = "service"): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`Invalid ${label} origin.`); }
  if (url.protocol !== "https:") throw new Error(`${label} origin must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} origin must not contain credentials.`);
  return url.origin;
}

function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error("Invalid service request URL.")); return; }
    if (u.protocol !== "https:") { reject(new Error("Service requests must use HTTPS.")); return; }
    const opts = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : 443,
      path: u.pathname + u.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...headers,
        ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
      },
    };

    const req = https.request(opts, (res) => {
      let data = "";
      let bytes = 0;
      let failed = false;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_SERVICE_RESPONSE_BYTES) {
          failed = true;
          res.destroy(new Error(`Service response exceeded ${MAX_SERVICE_RESPONSE_BYTES} bytes.`));
          return;
        }
        data += chunk.toString();
      });
      res.on("end", () => { if (!failed) resolve({ statusCode: res.statusCode ?? 0, body: data }); });
      // Every response error must settle the promise, not only the size-cap one: a connection
      // reset mid-body emits no "end", and swallowing it left the tool call pending forever.
      res.on("error", reject);
      res.on("close", () => {
        if (!res.complete) reject(new Error("Service response closed before it completed."));
      });
    });
    req.on("error", reject);
    req.setTimeout(SERVICE_TIMEOUT_MS, () => req.destroy(new Error(`Service request timed out after ${SERVICE_TIMEOUT_MS}ms.`)));
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { rawBody: text }; }
}

/**
 * One model-supplied URL path segment. Encoded so it cannot add segments, a query, or a
 * fragment — and never `.`/`..`, because URL parsing normalizes dot segments: an issue
 * `number` of `../../../user/keys` would otherwise send this credential's request (possibly an
 * approved mutation, whose prompt names only the tool) to an endpoint the user never saw.
 */
function segment(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`Missing ${label}.`);
  if (raw === "." || raw === "..") throw new Error(`Invalid ${label}: ${raw}`);
  return encodeURIComponent(raw);
}

/** A repository file path: each `/`-separated part is validated as its own segment. */
function segments(value: unknown, label: string): string {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) throw new Error(`Missing ${label}.`);
  return parts.map((part) => segment(part, label)).join("/");
}

function query(value: unknown, fallback: string): string {
  return encodeURIComponent(String(value ?? fallback));
}

function pageSize(value: unknown, fallback: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number(value ?? fallback)) || fallback, 1), max);
}

async function apiCall(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ ok: boolean; statusCode: number; data: unknown }> {
  const { statusCode, body: rawBody } = await httpRequest(
    url, method, headers, body ? JSON.stringify(body) : undefined,
  );
  const data = parseJson(rawBody);
  return { ok: statusCode >= 200 && statusCode < 300, statusCode, data };
}

// ── GitHub ─────────────────────────────────────────────────────────────────────

const GITHUB_BASE = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "User-Agent": "Blacksite-Agent/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function handleGithub(token: string, payload: Record<string, unknown>): Promise<unknown> {
  const op = String(payload["op"] ?? "");
  const h  = ghHeaders(token);
  // Resolved per operation: search_code has no repository, and a missing owner/repo should
  // fail with a clear message rather than request `/repos///…`.
  const repoBase = (): string =>
    `${GITHUB_BASE}/repos/${segment(payload["owner"], "owner")}/${segment(payload["repo"], "repo")}`;

  switch (op) {
    case "list_issues": {
      const state = query(payload["state"], "open");
      const limit = pageSize(payload["limit"], 30, 100);
      return apiCall(`${repoBase()}/issues?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_issue": {
      return apiCall(`${repoBase()}/issues/${segment(payload["number"], "number")}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${repoBase()}/issues`, "POST", h, {
        title: payload["title"], body: payload["body"], labels: payload["labels"] ?? [],
      });
    }
    case "list_prs": {
      const state = query(payload["state"], "open");
      const limit = pageSize(payload["limit"], 30, 100);
      return apiCall(`${repoBase()}/pulls?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_pr": {
      return apiCall(`${repoBase()}/pulls/${segment(payload["number"], "number")}`, "GET", h);
    }
    case "get_pr_context": {
      const base = repoBase();
      const number = segment(payload["number"], "number");
      const [pull, files, reviews, comments] = await Promise.all([
        apiCall(`${base}/pulls/${number}`, "GET", h),
        apiCall(`${base}/pulls/${number}/files?per_page=100`, "GET", h),
        apiCall(`${base}/pulls/${number}/reviews?per_page=100`, "GET", h),
        apiCall(`${base}/issues/${number}/comments?per_page=100`, "GET", h),
      ]);
      return { ok: pull.ok && files.ok, pull, files, reviews, comments };
    }
    case "create_pr": {
      return apiCall(`${repoBase()}/pulls`, "POST", h, {
        title: payload["title"], body: payload["body"], head: payload["head"], base: payload["base"] ?? "main",
      });
    }
    case "list_branches": {
      const limit = pageSize(payload["limit"], 30, 100);
      return apiCall(`${repoBase()}/branches?per_page=${limit}`, "GET", h);
    }
    case "get_file": {
      const filePath = segments(payload["path"], "path");
      const ref = payload["ref"] ? `?ref=${query(payload["ref"], "")}` : "";
      return apiCall(`${repoBase()}/contents/${filePath}${ref}`, "GET", h);
    }
    case "search_code": {
      const q = encodeURIComponent(String(payload["query"] ?? ""));
      return apiCall(`${GITHUB_BASE}/search/code?q=${q}&per_page=20`, "GET", h);
    }
    case "add_comment": {
      return apiCall(`${repoBase()}/issues/${segment(payload["number"], "number")}/comments`, "POST", h, {
        body: payload["body"],
      });
    }
    default:
      return { ok: false, error: `Unknown GitHub op: ${op}` };
  }
}

// ── GitLab ─────────────────────────────────────────────────────────────────────

function glHeaders(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token, "User-Agent": "Blacksite-Agent/1.0" };
}

export async function handleGitlab(token: string, payload: Record<string, unknown>): Promise<unknown> {
  const op        = String(payload["op"] ?? "");
  const host      = normalizeServiceOrigin(String(payload["host"] ?? "https://gitlab.com"), "GitLab");
  // A `group/project` path is one segment here, so its slash is encoded as GitLab expects.
  const projectId = segment(payload["projectId"], "projectId");
  const base      = `${host}/api/v4/projects/${projectId}`;
  const h         = glHeaders(token);

  switch (op) {
    case "list_issues": {
      const state = query(payload["state"], "opened");
      const limit = pageSize(payload["limit"], 20, 100);
      return apiCall(`${base}/issues?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_issue": {
      return apiCall(`${base}/issues/${segment(payload["iid"], "iid")}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${base}/issues`, "POST", h, {
        title: payload["title"], description: payload["description"], labels: payload["labels"],
      });
    }
    case "list_mrs": {
      const state = query(payload["state"], "opened");
      const limit = pageSize(payload["limit"], 20, 100);
      return apiCall(`${base}/merge_requests?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_mr": {
      return apiCall(`${base}/merge_requests/${segment(payload["iid"], "iid")}`, "GET", h);
    }
    case "get_mr_context": {
      const iid = segment(payload["iid"], "iid");
      const [mergeRequest, changes, pipelines, notes] = await Promise.all([
        apiCall(`${base}/merge_requests/${iid}`, "GET", h),
        apiCall(`${base}/merge_requests/${iid}/changes`, "GET", h),
        apiCall(`${base}/merge_requests/${iid}/pipelines?per_page=100`, "GET", h),
        apiCall(`${base}/merge_requests/${iid}/notes?per_page=100`, "GET", h),
      ]);
      return { ok: mergeRequest.ok && changes.ok, mergeRequest, changes, pipelines, notes };
    }
    case "create_mr": {
      return apiCall(`${base}/merge_requests`, "POST", h, {
        title: payload["title"], description: payload["description"],
        source_branch: payload["sourceBranch"], target_branch: payload["targetBranch"] ?? "main",
      });
    }
    case "list_branches": {
      const limit = pageSize(payload["limit"], 20, 100);
      return apiCall(`${base}/repository/branches?per_page=${limit}`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown GitLab op: ${op}` };
  }
}

// ── Jira ───────────────────────────────────────────────────────────────────────

function jiraHeaders(email: string, token: string): Record<string, string> {
  const creds = Buffer.from(`${email}:${token}`).toString("base64");
  return { "Authorization": `Basic ${creds}`, "User-Agent": "Blacksite-Agent/1.0" };
}

export async function handleJira(email: string, token: string, payload: Record<string, unknown>): Promise<unknown> {
  const op   = String(payload["op"] ?? "");
  const host = normalizeServiceOrigin(String(payload["host"] ?? ""), "Jira");
  const base = `${host}/rest/api/3`;
  const h    = jiraHeaders(email, token);

  switch (op) {
    case "list_issues": {
      const jql   = String(payload["jql"] ?? "");
      const limit = pageSize(payload["limit"], 20, 100);
      const fields = ["summary", "status", "assignee", "priority", "issuetype", "description"];
      return apiCall(`${base}/search`, "POST", h, { jql, maxResults: limit, fields });
    }
    case "get_issue": {
      return apiCall(`${base}/issue/${segment(payload["key"], "key")}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${base}/issue`, "POST", h, {
        fields: {
          project: { key: payload["project"] },
          summary: payload["summary"],
          description: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: String(payload["description"] ?? "") }] }] },
          issuetype: { name: payload["issueType"] ?? "Task" },
        },
      });
    }
    case "update_issue": {
      return apiCall(`${base}/issue/${segment(payload["key"], "key")}`, "PUT", h, { fields: payload["fields"] });
    }
    case "add_comment": {
      return apiCall(`${base}/issue/${segment(payload["key"], "key")}/comment`, "POST", h, {
        body: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: String(payload["body"] ?? "") }] }] },
      });
    }
    case "list_projects": {
      const limit = pageSize(payload["limit"], 50, 200);
      return apiCall(`${base}/project/search?maxResults=${limit}`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Jira op: ${op}` };
  }
}

// ── Confluence ─────────────────────────────────────────────────────────────────

export async function handleConfluence(email: string, token: string, payload: Record<string, unknown>): Promise<unknown> {
  const op   = String(payload["op"] ?? "");
  const host = normalizeServiceOrigin(String(payload["host"] ?? ""), "Confluence");
  const base = `${host}/wiki/rest/api`;
  const h    = jiraHeaders(email, token); // same Basic auth

  switch (op) {
    case "search": {
      const q     = encodeURIComponent(String(payload["query"] ?? ""));
      const limit = pageSize(payload["limit"], 20, 50);
      return apiCall(`${base}/content/search?cql=${q}&limit=${limit}`, "GET", h);
    }
    case "get_page": {
      return apiCall(`${base}/content/${segment(payload["pageId"], "pageId")}?expand=body.storage,version,ancestors`, "GET", h);
    }
    case "create_page": {
      return apiCall(`${base}/content`, "POST", h, {
        type: "page",
        title: payload["title"],
        space: { key: payload["spaceKey"] },
        body: { storage: { value: String(payload["body"] ?? ""), representation: "storage" } },
        ancestors: payload["parentId"] ? [{ id: payload["parentId"] }] : undefined,
      });
    }
    case "update_page": {
      const pageId = segment(payload["pageId"], "pageId");
      const version = Number(payload["version"] ?? 1);
      return apiCall(`${base}/content/${pageId}`, "PUT", h, {
        version: { number: version + 1 },
        title: payload["title"],
        type: "page",
        body: { storage: { value: String(payload["body"] ?? ""), representation: "storage" } },
      });
    }
    case "list_spaces": {
      const limit = pageSize(payload["limit"], 25, 100);
      return apiCall(`${base}/space?limit=${limit}`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Confluence op: ${op}` };
  }
}

// ── Salesforce ─────────────────────────────────────────────────────────────────

function sfHeaders(token: string): Record<string, string> {
  return { "Authorization": `Bearer ${token}`, "User-Agent": "Blacksite-Agent/1.0" };
}

export async function handleSalesforce(token: string, payload: Record<string, unknown>): Promise<unknown> {
  const op          = String(payload["op"] ?? "");
  const instanceUrl = normalizeServiceOrigin(String(payload["instanceUrl"] ?? ""), "Salesforce");
  const base        = `${instanceUrl}/services/data/v59.0`;
  const h           = sfHeaders(token);

  switch (op) {
    case "query": {
      const soql = encodeURIComponent(String(payload["soql"] ?? ""));
      return apiCall(`${base}/query?q=${soql}`, "GET", h);
    }
    case "get_object": {
      const type = segment(payload["objectType"], "objectType");
      const id   = segment(payload["id"], "id");
      return apiCall(`${base}/sobjects/${type}/${id}`, "GET", h);
    }
    case "create_object": {
      const type = segment(payload["objectType"], "objectType");
      return apiCall(`${base}/sobjects/${type}`, "POST", h, payload["fields"]);
    }
    case "update_object": {
      const type   = segment(payload["objectType"], "objectType");
      const id     = segment(payload["id"], "id");
      return apiCall(`${base}/sobjects/${type}/${id}`, "PATCH", h, payload["fields"]);
    }
    case "list_objects": {
      return apiCall(`${base}/sobjects`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Salesforce op: ${op}` };
  }
}
