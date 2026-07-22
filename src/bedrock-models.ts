/**
 * Live Bedrock model listing: foundation models + inference profiles via the
 * signed Bedrock control-plane API. Ported from the chrome extension
 * (src/background/bedrock-models.ts).
 */

import type { BedrockCredentials } from "./bedrock-types.js";
import { signBedrockRequest } from "./bedrock-client.js";
import { getContextLength, getMaxOutputTokens, type ModelInfo } from "./model-fetcher.js";
import { supportsThinking } from "./thinking-modes.js";

const BEDROCK_CONTROL_TIMEOUT_MS = 30_000;
const INFERENCE_PROFILE_PAGE_SIZE = 1000;
const MAX_INFERENCE_PROFILE_PAGES = 10;

export type BedrockAvailableModelSource = "foundation_model" | "inference_profile";

export interface BedrockAvailableModel {
  id: string;
  label: string;
  providerName: string;
  source: BedrockAvailableModelSource;
  modalities: string[];
  inferenceTypes: string[];
  customizationsSupported: string[];
  responseStreamingSupported?: boolean;
  status?: string;
  foundationModelId?: string;
  profileType?: string;
  description?: string;
}

export interface BedrockAvailableModelsData {
  models: BedrockAvailableModel[];
  refreshedAt: string;
  warnings: string[];
}

type BedrockModelListResult =
  | { ok: true; data: BedrockAvailableModelsData }
  | { ok: false; error: string };

type BedrockApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function titleCaseProvider(value: string): string {
  if (!value) return "Unknown";
  const normalized = value.replace(/[-_]+/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferProviderName(modelId: string): string {
  const provider = modelId.includes(".") ? modelId.split(".")[0] ?? "" : "";
  if (!provider) return "Unknown";
  return titleCaseProvider(provider);
}

function extractFoundationModelIdFromArn(arn: string): string {
  const marker = ":foundation-model/";
  const markerIndex = arn.indexOf(marker);
  if (markerIndex >= 0) return arn.slice(markerIndex + marker.length);
  const slashIndex = arn.lastIndexOf("/");
  return slashIndex >= 0 ? arn.slice(slashIndex + 1) : arn;
}

function shortModelLabel(modelId: string): string {
  const parts = modelId.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : modelId;
}

function getStatus(summary: Record<string, unknown>): string | undefined {
  if (!isRecord(summary["modelLifecycle"])) return undefined;
  const status = stringValue(summary["modelLifecycle"]["status"]);
  return status || undefined;
}

function mapFoundationModel(summary: Record<string, unknown>): BedrockAvailableModel | null {
  const id = stringValue(summary["modelId"]);
  if (!id) return null;

  const outputModalities = stringArrayValue(summary["outputModalities"]);
  if (outputModalities.length > 0 && !outputModalities.includes("TEXT")) return null;

  const inputModalities = stringArrayValue(summary["inputModalities"]);
  const modalities = Array.from(new Set([...inputModalities, ...outputModalities]));
  const providerName = stringValue(summary["providerName"]) || inferProviderName(id);
  const modelName = stringValue(summary["modelName"]) || shortModelLabel(id);

  return {
    id,
    label: `${providerName} ${modelName}`,
    providerName,
    source: "foundation_model",
    modalities,
    inferenceTypes: stringArrayValue(summary["inferenceTypesSupported"]),
    customizationsSupported: stringArrayValue(summary["customizationsSupported"]),
    responseStreamingSupported: booleanValue(summary["responseStreamingSupported"]),
    status: getStatus(summary),
  };
}

function extractProfileFoundationModelId(profile: Record<string, unknown>): string {
  const firstModel = arrayValue(profile["models"])[0];
  if (!isRecord(firstModel)) return "";
  const modelArn = stringValue(firstModel["modelArn"]);
  return modelArn ? extractFoundationModelIdFromArn(modelArn) : "";
}

function mapInferenceProfile(profile: Record<string, unknown>): BedrockAvailableModel | null {
  const id = stringValue(profile["inferenceProfileId"]) || stringValue(profile["inferenceProfileArn"]);
  if (!id) return null;

  const name = stringValue(profile["inferenceProfileName"]) || id;
  const foundationModelId = extractProfileFoundationModelId(profile);
  const providerName = foundationModelId ? inferProviderName(foundationModelId) : inferProviderName(id);
  const modelLabel = foundationModelId ? ` (${shortModelLabel(foundationModelId)})` : "";

  return {
    id,
    label: `${name}${modelLabel}`,
    providerName,
    source: "inference_profile",
    modalities: ["TEXT"],
    inferenceTypes: ["INFERENCE_PROFILE"],
    customizationsSupported: [],
    status: stringValue(profile["status"]) || undefined,
    foundationModelId: foundationModelId || undefined,
    profileType: stringValue(profile["type"]) || undefined,
    description: stringValue(profile["description"]) || undefined,
  };
}

function enrichInferenceProfiles(
  profiles: BedrockAvailableModel[],
  foundationModels: BedrockAvailableModel[],
): BedrockAvailableModel[] {
  const foundationById = new Map(foundationModels.map((model) => [model.id, model]));
  return profiles.map((model) => {
    if (model.source !== "inference_profile" || !model.foundationModelId) return model;
    const foundation = foundationById.get(model.foundationModelId);
    if (!foundation) return model;
    return {
      ...model,
      providerName: model.providerName || foundation.providerName,
      responseStreamingSupported: foundation.responseStreamingSupported,
      customizationsSupported: foundation.customizationsSupported,
    };
  });
}

async function bedrockGetJson<T>(
  creds: BedrockCredentials,
  path: string,
  query: Record<string, string>,
): Promise<BedrockApiResult<T>> {
  const url = new URL(`https://bedrock.${creds.region}.amazonaws.com${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };

  try {
    const signedHeaders = signBedrockRequest(creds, "GET", url.toString(), headers, "");
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: signedHeaders,
      signal: AbortSignal.timeout(BEDROCK_CONTROL_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      try {
        const parsed = JSON.parse(errorText) as { message?: string; Message?: string };
        return { ok: false, error: `Bedrock ${response.status}: ${parsed.message ?? parsed.Message ?? errorText}` };
      } catch {
        return { ok: false, error: `Bedrock ${response.status}: ${errorText}` };
      }
    }

    return { ok: true, data: await response.json() as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function listFoundationModels(creds: BedrockCredentials): Promise<BedrockApiResult<BedrockAvailableModel[]>> {
  const response = await bedrockGetJson<{ modelSummaries?: unknown }>(
    creds,
    "/foundation-models",
    { byOutputModality: "TEXT" },
  );
  if (!response.ok) return response;

  const models = arrayValue(response.data.modelSummaries)
    .map((summary) => isRecord(summary) ? mapFoundationModel(summary) : null)
    .filter((model): model is BedrockAvailableModel => model !== null);

  return { ok: true, data: models };
}

async function listInferenceProfiles(creds: BedrockCredentials): Promise<BedrockApiResult<BedrockAvailableModel[]>> {
  const models: BedrockAvailableModel[] = [];
  let nextToken = "";

  for (let page = 0; page < MAX_INFERENCE_PROFILE_PAGES; page += 1) {
    const response = await bedrockGetJson<{ inferenceProfileSummaries?: unknown; nextToken?: unknown }>(
      creds,
      "/inference-profiles",
      { maxResults: String(INFERENCE_PROFILE_PAGE_SIZE), nextToken },
    );
    if (!response.ok) return response;

    models.push(
      ...arrayValue(response.data.inferenceProfileSummaries)
        .map((profile) => isRecord(profile) ? mapInferenceProfile(profile) : null)
        .filter((model): model is BedrockAvailableModel => model !== null),
    );

    nextToken = stringValue(response.data.nextToken);
    if (!nextToken) break;
  }

  return { ok: true, data: models };
}

/**
 * A foundation model can only be invoked by bare modelId when AWS lists ON_DEMAND among its
 * inference types. Newer Claude models are INFERENCE_PROFILE-only: passing their foundation id
 * to Converse fails with "Invocation of model ID ... with on-demand throughput isn't supported",
 * so they must be reached through their `us.`-prefixed profile, which the profile listing already
 * surfaces. An empty list means AWS didn't say — keep those rather than hide a usable model.
 */
export function isOnDemandInvokable(model: BedrockAvailableModel): boolean {
  if (model.source === "inference_profile") return true;
  if (model.inferenceTypes.length === 0) return true;
  return model.inferenceTypes.includes("ON_DEMAND");
}

function sourceRank(source: BedrockAvailableModelSource): number {
  return source === "inference_profile" ? 0 : 1;
}

function sortModels(models: BedrockAvailableModel[]): BedrockAvailableModel[] {
  return [...models].sort((a, b) => {
    const sourceDiff = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDiff !== 0) return sourceDiff;
    const providerDiff = a.providerName.localeCompare(b.providerName);
    if (providerDiff !== 0) return providerDiff;
    return a.label.localeCompare(b.label);
  });
}

function dedupeModels(models: BedrockAvailableModel[]): BedrockAvailableModel[] {
  const byId = new Map<string, BedrockAvailableModel>();
  for (const model of sortModels(models)) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return Array.from(byId.values());
}

export async function listAvailableBedrockModels(creds: BedrockCredentials): Promise<BedrockModelListResult> {
  const [foundationResult, profileResult] = await Promise.all([
    listFoundationModels(creds),
    listInferenceProfiles(creds),
  ]);

  const warnings: string[] = [];
  const models: BedrockAvailableModel[] = [];

  if (foundationResult.ok) {
    models.push(...foundationResult.data);
  } else {
    warnings.push(`Foundation models unavailable: ${foundationResult.error}`);
  }

  if (profileResult.ok) {
    models.push(...enrichInferenceProfiles(profileResult.data, foundationResult.ok ? foundationResult.data : []));
  } else {
    warnings.push(`Inference profiles unavailable: ${profileResult.error}`);
  }

  if (!foundationResult.ok && !profileResult.ok) {
    return { ok: false, error: warnings.join(" ") };
  }

  const invokable = models.filter(isOnDemandInvokable);
  const hidden = models.length - invokable.length;
  if (hidden > 0) {
    warnings.push(`${hidden} model(s) require an inference profile and were hidden; use their "us." profile entry.`);
  }

  return {
    ok: true,
    data: { models: dedupeModels(invokable), refreshedAt: new Date().toISOString(), warnings },
  };
}

/** Map listed Bedrock models to the picker's ModelInfo shape. */
export function bedrockModelsToModelInfo(models: BedrockAvailableModel[]): ModelInfo[] {
  return models.map((model) => {
    const contextModelId = model.foundationModelId || model.id;
    return {
      id: model.id,
      name: model.label,
      contextLength: getContextLength("bedrock", contextModelId),
      maxOutputTokens: getMaxOutputTokens("bedrock", contextModelId),
      // Shared with the request builder, so the picker can't advertise thinking on a model the
      // request layer would refuse to enable it for (the old local regex missed Sonnet 5 / Fable,
      // whose ids carry no "-4" — they'd have shown up as non-thinking models).
      supportsThinking: supportsThinking(contextModelId),
      supportsVision: contextModelId.toLowerCase().includes("claude"),
      supportsTools: true,
      source: "api" as const,
    };
  });
}
