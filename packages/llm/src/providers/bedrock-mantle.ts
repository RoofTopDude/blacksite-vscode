/*
  The Bedrock Mantle route: the Anthropic Messages API behind a SigV4-signed Bedrock endpoint.
*/
import { mantleEndpoint, signBedrockRequest } from "../bedrock-client.js";
import { applyAnthropicThinking, resolveAnthropicBetaExtras } from "../thinking-plan.js";
import type { ProviderTurnStreamEvent } from "../types.js";
import { buildAnthropicSystemBlocks } from "../wire/anthropic.js";
import { fetchWithRetry } from "../transport/fetch-retry.js";
import { resolveCredential, type ModelRequest, type TransportContext } from "../transport/request.js";
import { anthropicWireMessages, buildAnthropicWireTools, looksLikeStrictRejection, parseAnthropicSSE } from "./anthropic.js";

export async function* streamBedrockMantle(ctx: TransportContext, req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
  const credentials = await resolveCredential(ctx.config.bedrock);
  if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");

  // Mantle is the Anthropic Messages API behind a SigV4-signed Bedrock endpoint, so it takes the
  // Messages thinking shape verbatim — including `output_config.effort`. It previously hardcoded
  // `{type: "adaptive"}` for every model, which 400s on the budget-era models (3.7 – 4.5) that
  // only accept `budget_tokens`; the plan below picks the dialect the selected model speaks.
  const plan = req.thinking;
  const extras = resolveAnthropicBetaExtras(req.model, req.anthropicBeta ?? {}, true);

  const url = `${mantleEndpoint(credentials.region)}/anthropic/v1/messages`;
  // Body + SigV4 signature are built together: a retry with different tools (the strict
  // fallback below) must re-sign, since the signature covers the payload hash.
  const makeRequest = async (): Promise<{ body: string; signedHeaders: Record<string, string> }> => {
    const toolPlan = req.tools;
    const reqBody: Record<string, unknown> = {
      model: req.model,
      max_tokens: plan.maxTokens,
      // Mantle uses the Anthropic Messages wire format — reuse the same cached-blocks
      // builder so the stable system-prompt head is cache-eligible here too.
      system: buildAnthropicSystemBlocks(req.system, req.systemSummary, ctx.config.cacheTtl),
      messages: anthropicWireMessages(ctx, req, new Set(toolPlan.wire.map((tool) => tool.name))),
      tools: buildAnthropicWireTools(ctx, toolPlan),
      stream: true,
    };
    if (plan.temperature !== undefined) reqBody["temperature"] = plan.temperature;
    applyAnthropicThinking(reqBody, plan);
    Object.assign(reqBody, extras.bodyExtras);
    const body = JSON.stringify(reqBody);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(extras.betas.length > 0 ? { "anthropic-beta": extras.betas.join(",") } : {}),
    };
    return { body, signedHeaders: await signBedrockRequest(credentials, "POST", url, headers, body, "bedrock-mantle") };
  };
  let request = await makeRequest();

  const doFetch = (signal: AbortSignal | undefined): Promise<Response> =>
    fetch(url, { method: "POST", headers: request.signedHeaders, body: request.body, signal });
  let response = yield* fetchWithRetry(ctx, "Bedrock Mantle", doFetch);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Same strict-rejection fallback as the Anthropic-direct path — see _buildAnthropicWireTools.
    if (!ctx.latches.strictToolsUnsupported && looksLikeStrictRejection(response.status, text)) {
      ctx.latches.strictToolsUnsupported = true;
      yield { type: "notice", level: "warn", message: "Strict tool schemas were rejected by the endpoint — retrying this turn without them." };
      request = await makeRequest();
      response = yield* fetchWithRetry(ctx, "Bedrock Mantle", doFetch);
      if (!response.ok) {
        const retryText = await response.text().catch(() => "");
        throw new Error(`Bedrock Mantle ${response.status}: ${retryText.slice(0, 400)}`);
      }
    } else {
      throw new Error(`Bedrock Mantle ${response.status}: ${text.slice(0, 400)}`);
    }
  }
  if (!response.body) throw new Error("No response body from Bedrock Mantle");

  yield* parseAnthropicSSE(response.body, ctx.config.provider, req.messages);
}
