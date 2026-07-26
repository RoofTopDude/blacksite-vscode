import { spawn } from "child_process";
import type { McpServer } from "./types.js";

const RPC_TIMEOUT_MS = 30_000;

function buildHeaders(apiKey: string, extraHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json, text/event-stream";
  return headers;
}

function normalizeServer(server: McpServer): { url: string; apiKey: string; headers: Record<string, string> } {
  return {
    url: typeof server.url === "string" ? server.url.trim() : "",
    apiKey: typeof server.apiKey === "string" ? server.apiKey : "",
    headers: server.headers && typeof server.headers === "object" ? server.headers : {},
  };
}

function parseSseLine(line: string): { key: string; value: string } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const key = line.slice(0, colonIdx).trim();
  let value = line.slice(colonIdx + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return { key, value };
}

function parseSseJsonRpcResponse(text: string): unknown {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try { return JSON.parse(data); } catch { continue; }
  }
  return null;
}

function parseJsonRpcResponse(text: string, contentType: string): unknown {
  try { return JSON.parse(text); } catch {
    const isEventStream = contentType.toLowerCase().includes("text/event-stream") || /^event:|^data:/m.test(text);
    if (isEventStream) {
      const parsed = parseSseJsonRpcResponse(text);
      if (parsed) return parsed;
    }
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function trySseCall(urlStr: string, method: string, params: unknown, headers: Record<string, string>): Promise<unknown> {
  const url = new URL(urlStr);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await fetch(urlStr, {
      method: "GET",
      headers: { ...headers, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`SSE GET failed with HTTP ${response.status}`);
    const ct = response.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/event-stream")) throw new Error("Response is not an event stream");
    if (!response.body) throw new Error("No response body in SSE stream");

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";
    let postSent = false;
    const requestId = 1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const cleanLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (cleanLine === "") {
          if (currentData) {
            if (currentEvent === "endpoint" && !postSent) {
              const endpointUrl = new URL(currentData.trim(), url);
              if (endpointUrl.origin !== url.origin) throw new Error(`Endpoint origin mismatch: ${endpointUrl.origin}`);
              postSent = true;
              const postResponse = await fetch(endpointUrl.href, {
                method: "POST", headers,
                body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
                signal: controller.signal,
              });
              if (!postResponse.ok) {
                const errorText = await postResponse.text().catch(() => "");
                throw new Error(`POST to endpoint failed with HTTP ${postResponse.status}: ${errorText}`);
              }
              const postCt = postResponse.headers.get("content-type") ?? "";
              if (postCt.toLowerCase().includes("application/json")) {
                const jsonText = await postResponse.text();
                try {
                  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
                  if (parsed && typeof parsed === "object" && parsed["id"] === requestId) return parsed;
                } catch { /* keep streaming */ }
              } else {
                await postResponse.body?.cancel();
              }
            } else if (currentEvent === "message" || !currentEvent) {
              try {
                const parsed = JSON.parse(currentData.trim()) as Record<string, unknown>;
                if (parsed && typeof parsed === "object" && parsed["id"] === requestId) return parsed;
              } catch { /* ignore intermediate events */ }
            }
          }
          currentEvent = "";
          currentData = "";
          continue;
        }
        const parsed = parseSseLine(cleanLine);
        if (!parsed) continue;
        if (parsed.key === "event") currentEvent = parsed.value;
        else if (parsed.key === "data") currentData = currentData ? `${currentData}\n${parsed.value}` : parsed.value;
      }
    }
    throw new Error("SSE connection closed before response was received");
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* best effort */ }
  }
}

async function rpcDirectPostCall(url: string, method: string, params: unknown, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(url.replace(/\/+$/, ""), {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJsonRpcResponse(text, response.headers.get("content-type") ?? "");
    if (!response.ok) throw new Error((parsed as Record<string, Record<string, string>>)?.["error"]?.["message"] ?? `HTTP ${response.status}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcHttpCall(url: string, method: string, params: unknown, headers: Record<string, string>): Promise<unknown> {
  try {
    return await trySseCall(url, method, params, headers);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return await rpcDirectPostCall(url, method, params, headers);
  }
}

function parseCommandLine(cmdString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < cmdString.length; i++) {
    const char = cmdString[i]!;
    if (inQuotes) {
      if (char === quoteChar) inQuotes = false;
      else current += char;
    } else {
      if (char === '"' || char === "'") { inQuotes = true; quoteChar = char; }
      else if (/\s/.test(char)) { if (current) { args.push(current); current = ""; } }
      else current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

function executeLocalStdioMcp(command: string, args: string[], method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: true });
    let stdoutBuffer = "";
    let stderr = "";
    const requestId = 1;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Local stdio MCP server timed out."));
    }, RPC_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBuffer += chunk.toString("utf8");
      let nlIdx: number;
      while ((nlIdx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed["id"] === requestId) {
            settled = true; clearTimeout(timer); child.kill(); resolve(parsed); return;
          }
        } catch { /* non-JSON stdout line — ignore */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const line = stdoutBuffer.trim();
      if (line) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed["id"] === requestId) { resolve(parsed); return; }
        } catch { /* ignore */ }
      }
      reject(new Error(`Local stdio MCP exited (${code}) without a valid response. Stderr: ${stderr.trim().slice(0, 200)}`));
    });

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    child.stdin.end();
  });
}

export async function listMcpTools(server: McpServer): Promise<unknown> {
  const s = normalizeServer(server);
  if (!s.url) throw new Error("Missing MCP URL or command.");
  if (/^https?:\/\//i.test(s.url)) {
    return rpcHttpCall(s.url, "tools/list", {}, buildHeaders(s.apiKey, s.headers));
  }
  const tokens = parseCommandLine(s.url);
  return executeLocalStdioMcp(tokens[0]!, tokens.slice(1), "tools/list", {});
}

export async function callMcpTool(server: McpServer, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const s = normalizeServer(server);
  if (!s.url) throw new Error("Missing MCP URL or command.");
  const params = { name: toolName, arguments: args };
  if (/^https?:\/\//i.test(s.url)) {
    return rpcHttpCall(s.url, "tools/call", params, buildHeaders(s.apiKey, s.headers));
  }
  const tokens = parseCommandLine(s.url);
  return executeLocalStdioMcp(tokens[0]!, tokens.slice(1), "tools/call", params);
}
