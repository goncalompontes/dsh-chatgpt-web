import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig, NativeCodexConfig } from "./config";
import { defaultCodexAuthPath } from "./native-codex-auth";

/**
 * Models the Codex backend exposes for a ChatGPT subscription. The list is a fallback; when the
 * local Codex model cache is present its visible entries take precedence so a model rollout does
 * not require a plugin release.
 */
export const DEFAULT_NATIVE_CODEX_MODELS = [
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export const DEFAULT_NATIVE_CODEX_FALLBACK_MODEL = "chatgpt-web/high";

export interface ResolvedNativeCodexConfig {
  enabled: boolean;
  authPath: string;
  models: string[];
  browserFallback: boolean;
  fallbackModel: string;
}

function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function splitModels(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const models = value.split(",").map(entry => entry.trim()).filter(Boolean);
  return models.length > 0 ? models : undefined;
}

function cachedCodexModels(authPath: string): string[] | undefined {
  const cachePath = join(dirname(authPath), "models_cache.json");
  if (!existsSync(cachePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
    const models = rows
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
      .filter(row => row.visibility === undefined || row.visibility === "list")
      .map(row => typeof row.slug === "string" ? row.slug : typeof row.id === "string" ? row.id : undefined)
      .filter((model): model is string => typeof model === "string" && model.length > 0);
    return models.length > 0 ? [...new Set(models)] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the native route from config plus environment overrides.
 *
 * Disabled by default. `DSH_CHATGPT_NATIVE_CODEX=1` enables it without editing config, which is
 * useful for a staged rollout and for doctor/soak runs.
 */
export function resolveNativeCodexConfig(
  config: Pick<AppConfig, "nativeCodex"> | { nativeCodex?: NativeCodexConfig },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNativeCodexConfig {
  const configured = config.nativeCodex;
  const authPath = configured?.authPath?.trim()
    || env.DSH_CHATGPT_NATIVE_CODEX_AUTH?.trim()
    || defaultCodexAuthPath(env);
  const enabled = configured?.enabled === true
    || envFlag(env.DSH_CHATGPT_NATIVE_CODEX) === true;
  const configuredModels = configured?.models && configured.models.length > 0
    ? configured.models
    : splitModels(env.DSH_CHATGPT_NATIVE_CODEX_MODELS);
  const models = configuredModels
    ?? cachedCodexModels(authPath)
    ?? [...DEFAULT_NATIVE_CODEX_MODELS];
  const browserFallback = configured?.browserFallback !== false
    && envFlag(env.DSH_CHATGPT_NATIVE_CODEX_FALLBACK) !== false;
  const fallbackModel = configured?.fallbackModel?.trim()
    || env.DSH_CHATGPT_NATIVE_CODEX_FALLBACK_MODEL?.trim()
    || DEFAULT_NATIVE_CODEX_FALLBACK_MODEL;
  return {
    enabled,
    authPath,
    models: [...new Set(models)],
    browserFallback,
    fallbackModel,
  };
}

/** True when this request should use the Codex Responses backend instead of the browser. */
export function isNativeCodexModel(
  model: string,
  config: Pick<ResolvedNativeCodexConfig, "enabled" | "models">,
): boolean {
  if (!config.enabled) return false;
  if (config.models.includes(model)) return true;
  // Do not claim an unrelated provider's model. Only Codex-family slugs are native by default.
  return !model.startsWith("chatgpt-web/") && /^(?:gpt-|codex-)/.test(model);
}

/** Best browser route for a native model when the native transport is unavailable. */
export function nativeCodexBrowserFallback(
  model: string,
  config: Pick<ResolvedNativeCodexConfig, "fallbackModel">,
): string {
  if (config.fallbackModel && !config.fallbackModel.startsWith("gpt-")) return config.fallbackModel;
  if (/luna/i.test(model)) return "chatgpt-web/luna";
  if (/(?:gpt-6|astra|terra)/i.test(model)) return "chatgpt-web/gpt-6-high";
  return config.fallbackModel || DEFAULT_NATIVE_CODEX_FALLBACK_MODEL;
}
