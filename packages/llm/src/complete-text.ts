/*
  One-shot text completion: a system prompt and one user message (optionally with an image) in, the
  model's text out. No tools, no streaming, no cache markers, no thinking fields — the plain
  request shape small helper calls (a review verdict, a plan decision, describing an image for a
  model that cannot see) want, kept apart from the conversation routes on purpose.
*/
import { converseBedrock, mantleMessage } from "./bedrock-client.js";
import type { BedrockCredentials } from "./bedrock-types.js";
import { isOpenAIReasoningModel, type OpenAIReasoningEffort } from "./model-limits.js";
import { PROVIDER_BASE_URLS } from "./transport/request.js";
import type { ProviderName } from "./types.js";

export interface TextCompletionImage {
  mediaType: string;
  /** Base64 image bytes. */
  data: string;
}

export interface TextCompletionRequest {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
  image?: TextCompletionImage;
  /** Anthropic, OpenAI and OpenRouter. */
  apiKey?: string;
  /** Overrides the provider's endpoint. */
  baseUrl?: string;
  /** Bedrock credentials, and which Bedrock API to call. */
  bedrock?: BedrockCredentials;
  bedrockApi?: "converse" | "mantle";
  /** Direct OpenAI reasoning models only. */
  reasoningEffort?: OpenAIReasoningEffort;
  /** OpenRouter attribution headers. */
  httpReferer?: string;
  xTitle?: string;
}

/** Request shape shared by no-tools helpers such as continuation review and plan continuation. */
export function buildAssistantTextRequestBody(input: {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
  image?: TextCompletionImage;
  reasoningEffort?: OpenAIReasoningEffort;
}): Record<string, unknown> {
  const { provider, model, maxTokens, systemPrompt, userPrompt, image, reasoningEffort } = input;
  const reasoning = provider === "openai" && isOpenAIReasoningModel(model);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: image
          ? [
              { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
              { type: "text", text: userPrompt },
            ]
          : userPrompt,
      },
    ],
  };
  if (reasoning) {
    body["max_completion_tokens"] = maxTokens;
    if (reasoningEffort) body["reasoning_effort"] = reasoningEffort;
  } else {
    body["max_tokens"] = maxTokens;
  }
  return body;
}

/** Ask for one plain-text answer. Throws on a non-OK response; returns "" when no text came back. */
export async function completeText(req: TextCompletionRequest, signal?: AbortSignal): Promise<string> {
  const { provider, model, maxTokens, systemPrompt, userPrompt, image } = req;

  if (provider === "bedrock") {
    const config = req.bedrock;
    if (!config) throw new Error("No AWS credentials configured for Bedrock.");
    if (req.bedrockApi === "mantle") {
      const content: string | Array<Record<string, unknown>> = image
        ? [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: userPrompt },
          ]
        : userPrompt;
      const response = await mantleMessage({
        credentials: config,
        model,
        system: systemPrompt,
        maxTokens,
        messages: [{ role: "user", content }],
      }, signal);
      return response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
    }
    const bedrockFormat = (image?.mediaType.split("/")[1] ?? "png") as "png" | "jpeg" | "gif" | "webp";
    const response = await converseBedrock({
      credentials: config,
      modelId: model,
      systemPrompt,
      maxTokens,
      messages: [{
        role: "user",
        content: image
          ? [{ image: { format: bedrockFormat, source: { bytes: image.data } } }, { text: userPrompt }]
          : [{ text: userPrompt }],
      }],
    }, signal);
    return response.output.message.content
      .filter((block): block is { text: string } => "text" in block)
      .map((block) => block.text)
      .join("\n\n")
      .trim();
  }

  const apiKey = req.apiKey;
  if (!apiKey) throw new Error(`No API key configured for ${provider}.`);

  if (provider === "anthropic") {
    const response = await fetch(req.baseUrl?.trim() || PROVIDER_BASE_URLS.anthropic, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: image
            ? [
                { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
                { type: "text", text: userPrompt },
              ]
            : userPrompt,
        }],
      }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic error ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
    return data.content?.find((block) => block.type === "text")?.text?.trim() ?? "";
  }

  const baseUrl = req.baseUrl?.trim() || (provider === "openrouter"
    ? PROVIDER_BASE_URLS.openrouter
    : PROVIDER_BASE_URLS.openai);
  // Shares the same direct-OpenAI dialect rules as the main turn path.
  const body = buildAssistantTextRequestBody({
    provider,
    model,
    maxTokens,
    systemPrompt,
    userPrompt,
    image,
    reasoningEffort: req.reasoningEffort,
  });
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(provider === "openrouter" ? {
        "HTTP-Referer": req.httpReferer ?? "https://blacksite.dev",
        "X-Title": req.xTitle ?? "Blacksite",
      } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${provider} error ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
