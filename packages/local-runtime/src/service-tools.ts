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
      res.on("error", (error) => { if (failed) reject(error); });
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
  const op    = String(payload["op"] ?? "");
  const owner = String(payload["owner"] ?? "");
  const repo  = String(payload["repo"] ?? "");
  const h     = ghHeaders(token);

  switch (op) {
    case "list_issues": {
      const state = String(payload["state"] ?? "open");
      const limit = Math.min(Number(payload["limit"] ?? 30), 100);
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_issue": {
      const number = String(payload["number"] ?? "");
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues/${number}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues`, "POST", h, {
        title: payload["title"], body: payload["body"], labels: payload["labels"] ?? [],
      });
    }
    case "list_prs": {
      const state = String(payload["state"] ?? "open");
      const limit = Math.min(Number(payload["limit"] ?? 30), 100);
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_pr": {
      const number = String(payload["number"] ?? "");
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/pulls/${number}`, "GET", h);
    }
    case "create_pr": {
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/pulls`, "POST", h, {
        title: payload["title"], body: payload["body"], head: payload["head"], base: payload["base"] ?? "main",
      });
    }
    case "list_branches": {
      const limit = Math.min(Number(payload["limit"] ?? 30), 100);
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/branches?per_page=${limit}`, "GET", h);
    }
    case "get_file": {
      const filePath = String(payload["path"] ?? "");
      const ref = payload["ref"] ? `?ref=${String(payload["ref"])}` : "";
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/contents/${filePath}${ref}`, "GET", h);
    }
    case "search_code": {
      const q = encodeURIComponent(String(payload["query"] ?? ""));
      return apiCall(`${GITHUB_BASE}/search/code?q=${q}&per_page=20`, "GET", h);
    }
    case "add_comment": {
      const number = String(payload["number"] ?? "");
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues/${number}/comments`, "POST", h, {
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
  const projectId = encodeURIComponent(String(payload["projectId"] ?? ""));
  const base      = `${host}/api/v4/projects/${projectId}`;
  const h         = glHeaders(token);

  switch (op) {
    case "list_issues": {
      const state = String(payload["state"] ?? "opened");
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      return apiCall(`${base}/issues?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_issue": {
      return apiCall(`${base}/issues/${String(payload["iid"] ?? "")}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${base}/issues`, "POST", h, {
        title: payload["title"], description: payload["description"], labels: payload["labels"],
      });
    }
    case "list_mrs": {
      const state = String(payload["state"] ?? "opened");
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      return apiCall(`${base}/merge_requests?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_mr": {
      return apiCall(`${base}/merge_requests/${String(payload["iid"] ?? "")}`, "GET", h);
    }
    case "create_mr": {
      return apiCall(`${base}/merge_requests`, "POST", h, {
        title: payload["title"], description: payload["description"],
        source_branch: payload["sourceBranch"], target_branch: payload["targetBranch"] ?? "main",
      });
    }
    case "list_branches": {
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
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
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      const fields = ["summary", "status", "assignee", "priority", "issuetype", "description"];
      return apiCall(`${base}/search`, "POST", h, { jql, maxResults: limit, fields });
    }
    case "get_issue": {
      return apiCall(`${base}/issue/${String(payload["key"] ?? "")}`, "GET", h);
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
      const key = String(payload["key"] ?? "");
      return apiCall(`${base}/issue/${key}`, "PUT", h, { fields: payload["fields"] });
    }
    case "add_comment": {
      const key = String(payload["key"] ?? "");
      return apiCall(`${base}/issue/${key}/comment`, "POST", h, {
        body: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: String(payload["body"] ?? "") }] }] },
      });
    }
    case "list_projects": {
      const limit = Math.min(Number(payload["limit"] ?? 50), 200);
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
      const limit = Math.min(Number(payload["limit"] ?? 20), 50);
      return apiCall(`${base}/content/search?cql=${q}&limit=${limit}`, "GET", h);
    }
    case "get_page": {
      const pageId = String(payload["pageId"] ?? "");
      return apiCall(`${base}/content/${pageId}?expand=body.storage,version,ancestors`, "GET", h);
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
      const pageId = String(payload["pageId"] ?? "");
      const version = Number(payload["version"] ?? 1);
      return apiCall(`${base}/content/${pageId}`, "PUT", h, {
        version: { number: version + 1 },
        title: payload["title"],
        type: "page",
        body: { storage: { value: String(payload["body"] ?? ""), representation: "storage" } },
      });
    }
    case "list_spaces": {
      const limit = Math.min(Number(payload["limit"] ?? 25), 100);
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
      const type = String(payload["objectType"] ?? "");
      const id   = String(payload["id"] ?? "");
      return apiCall(`${base}/sobjects/${type}/${id}`, "GET", h);
    }
    case "create_object": {
      const type = String(payload["objectType"] ?? "");
      return apiCall(`${base}/sobjects/${type}`, "POST", h, payload["fields"]);
    }
    case "update_object": {
      const type   = String(payload["objectType"] ?? "");
      const id     = String(payload["id"] ?? "");
      return apiCall(`${base}/sobjects/${type}/${id}`, "PATCH", h, payload["fields"]);
    }
    case "list_objects": {
      return apiCall(`${base}/sobjects`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Salesforce op: ${op}` };
  }
}
