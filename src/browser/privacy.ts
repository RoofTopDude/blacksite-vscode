/** Remove exact entry values from display/history/log copies; executor memory is unchanged. */
export function browserTool(name: string): boolean { return name.startsWith("browser_") || name.startsWith("web_"); }
export function redactBrowserPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBrowserPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    if (["text", "value", "query", "script", "executedValues", "keys", "key", "html", "dom"].includes(key)) return [key, "[transient browser value omitted]"];
    if (key === "error") return [key, "[Browser failure details omitted from transcript; inspect the result code and current state.]"];
    if ((key.toLowerCase().includes("url") || key === "href") && typeof v === "string") {
      try { const u = new URL(v); u.username = ""; u.password = ""; u.hash = ""; for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "[redacted]"); return [key, u.href]; } catch { return [key, "[invalid URL]"]; }
    }
    return [key, redactBrowserPayload(v)];
  }));
}
