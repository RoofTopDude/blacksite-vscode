import * as https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { BrowserPolicyError, cancelled, withSignals } from "./approval-types.js";
import { researchUrl } from "./domain-policy.js";

export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    // Fail closed for all reserved ranges, mapped loopback, multicast and transition networks.
    return ip.range() === "unicast";
  } catch { return false; }
}
export interface RetrievedResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
export interface ResearchTransport {
  get(url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<RetrievedResponse>;
}
/** One request, no redirect following, no cookies, no proxy environment, no unchecked DNS lookup. */
export class PinnedResearchTransport implements ResearchTransport {
  async get(url: URL, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<RetrievedResponse> {
    researchUrl(url.href);
    cancelled(signal);
    return withSignals([signal, AbortSignal.timeout(20_000)], async deadline => {
      let abortResolution: (() => void) | undefined;
      const addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          abortResolution = () => reject(new BrowserPolicyError("cancelled", "Research resolution cancelled or timed out."));
          deadline.addEventListener("abort", abortResolution, { once: true });
          if (deadline.aborted) abortResolution();
        }),
      ]).finally(() => { if (abortResolution) deadline.removeEventListener("abort", abortResolution); });
      cancelled(deadline);
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new BrowserPolicyError("denied", "DNS resolved to a private or nonpublic destination.");
      const pinned = addresses[0]!;
      return new Promise((resolve, reject) => {
        const req = https.request(url, {
          method: "GET", agent: false, signal: deadline,
          // Keep the URL hostname for Host, SNI and TLS certificate checks. Only resolution is pinned.
          servername: url.hostname,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
          },
          headers: { "Accept-Encoding": "identity", "User-Agent": "Blacksite-Research/1", ...headers },
        }, response => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            response.destroy(); reject(new Error("Compressed research responses are unsupported; server must honor identity encoding.")); return;
          }
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2_000_000) { response.destroy(new Error("Research response exceeds 2 MB.")); return; }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
      });
    });
  }
}
