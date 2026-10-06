/** Remove exact entry values from display/history/log copies; executor memory is unchanged. */
export function browserTool(name: string): boolean { return name.startsWith("browser_") || name.startsWith("web_"); }
/** A research failure message with URL query strings removed and its length capped. */
export function researchErrorText(text: string): string {
  return text.replace(/https?:\/\/[^\s"')]+/g, (found) => {
    try { const u = new URL(found); u.username = ""; u.password = ""; u.hash = ""; for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "[redacted]"); return u.href; } catch { return "[url]"; }
  }).slice(0, 400);
}
/**
 * `keepErrors` is for the web_* research tools, whose failure text is policy and transport
 * wording (which hosts were denied, a status code, a limit) rather than anything typed into a
 * page. Hiding it left a log that said only "denied", and the reason had to be reproduced by hand.
 * The browser_* tools keep the blanket redaction because their errors can quote entered values.
 */
export function redactBrowserPayload(value: unknown, options: { keepErrors?: boolean } = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => redactBrowserPayload(item, options));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    if (key === "error" && options.keepErrors && typeof v === "string") return [key, researchErrorText(v)];
    if (["text", "value", "query", "script", "executedValues", "keys", "key", "html", "dom"].includes(key)) return [key, "[transient browser value omitted]"];
    if (key === "error") return [key, "[Browser failure details omitted from transcript; inspect the result code and current state.]"];
    if ((key.toLowerCase().includes("url") || key === "href") && typeof v === "string") {
      try { const u = new URL(v); u.username = ""; u.password = ""; u.hash = ""; for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "[redacted]"); return [key, u.href]; } catch { return [key, "[invalid URL]"]; }
    }
    return [key, redactBrowserPayload(v, options)];
  }));
}
