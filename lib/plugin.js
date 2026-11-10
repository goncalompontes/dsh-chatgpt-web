// src/plugin.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/config.ts
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";

// src/chatgpt-web-models.ts
var CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
var CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
var CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
var CHATGPT_WEB_GPT6_BACKEND_MODEL = "gpt-6";
var CHATGPT_WEB_MODEL_ROW_LABELS = {
  [CHATGPT_WEB_BACKEND_MODEL]: "GPT-5.6 Sol",
  [CHATGPT_WEB_GPT6_BACKEND_MODEL]: "GPT-6"
};
var CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL = "chatgpt-web-zero-risk";
var CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL = "chatgpt-web-zero-risk-pro";
var CHATGPT_WEB_INSTANT_CONTEXT_WINDOW = 41000;
var CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32000;
var CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW = CHATGPT_WEB_INSTANT_CONTEXT_WINDOW * 3;
var CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT = CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT * 3;
var CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW = 90000;
var CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80000;
var CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211256;
var CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 1048572;
var CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8192;
var CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT = 95000;
var CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103000;
var CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104000;
var CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW = CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
var CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW = CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
var CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW = CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW * 3;
var CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT = CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT * 3;
var CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545000;
var CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = 1045000;
var CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1635000;
var CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1050000;
var CHATGPT_WEB_CONTINUATION_CONTEXT_WINDOW = CHATGPT_WEB_LUNA_CONTEXT_WINDOW;
var CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3;
var CHATGPT_WEB_LUNA_COMPOSER_CHAR_LIMIT = 120000;
function isChatGptWebZeroRiskBackendModel(model) {
  return model === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL || model === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;
}
function contextLimits(contextWindow, autoCompactTokenLimit) {
  return {
    contextWindow,
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit,
    reportedContextWindow: CHATGPT_WEB_CONTINUATION_CONTEXT_WINDOW,
    reportedAutoCompactTokenLimit: CHATGPT_WEB_CONTINUATION_CONTEXT_WINDOW
  };
}
function resolveChatGptWebContextLimits(backendModel, effort, capabilities) {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    if (backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL) {
      return contextLimits(CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW, CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT);
    }
    return contextLimits(CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW, CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT);
  }
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return contextLimits(CHATGPT_WEB_LUNA_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_CONTEXT_WINDOW);
  }
  let limits;
  if (capabilities.proAvailable) {
    const contextWindow = effort === "low" ? CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW : effort === "max" ? CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW : CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW;
    limits = contextLimits(contextWindow, CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "low") {
    limits = contextLimits(CHATGPT_WEB_INSTANT_CONTEXT_WINDOW, CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "medium" || effort === "high") {
    limits = contextLimits(CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW, CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT);
  } else {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }
  if (!capabilities.experimentalBiggerContext)
    return limits;
  return contextLimits(limits.contextWindow * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER, limits.autoCompactTokenLimit * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
}
function resolveChatGptWebTransportLimits(backendModel, effort, capabilities) {
  if (isChatGptWebZeroRiskBackendModel(backendModel))
    return {};
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return { browserComposerCharLimit: CHATGPT_WEB_LUNA_COMPOSER_CHAR_LIMIT };
  }
  if (!capabilities.proAvailable) {
    if (effort === "low") {
      return { browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT };
    }
    if (effort === "medium" || effort === "high") {
      return { browserComposerCharLimit: CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT };
    }
    throw new Error(`ChatGPT Plus transport limit is not defined for unavailable effort: ${effort}`);
  }
  if (effort === "low") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT
    };
  }
  if (effort === "max") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT
  };
}
var CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE = {
  slug: "chatgpt-web/zero-risk",
  displayName: "ChatGPT Web — Zero Risk",
  description: "Zero Risk keeps model selection and prompt submission under your control while preserving the native Codex harness.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false
};
var CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE = {
  slug: "chatgpt-web/zero-risk-pro",
  displayName: "ChatGPT Web — Zero Risk Pro",
  description: "Explicit Pro-sized Zero Risk context; select ChatGPT Pro manually for every turn.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: true
};
var CHATGPT_WEB_LUNA_MODEL_ROUTE = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false
};
var CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE = {
  slug: "chatgpt-web/think",
  displayName: "ChatGPT Web — Think",
  description: "ChatGPT Web Think for Luna-only accounts.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "medium",
  requiresPro: false
};
var CHATGPT_WEB_LUNA_MODEL_ROUTES = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE
];
var CHATGPT_WEB_MODEL_ROUTES = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — GPT-5.6 Sol Instant (即时)",
    description: "通过原生 Codex 通道的 ChatGPT Web 即时档 (Instant)。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — GPT-5.6 Sol Medium (中等)",
    description: "通过原生 Codex 通道的 ChatGPT Web 中等档 (Medium)。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — GPT-5.6 Sol High (高)",
    description: "通过原生 Codex 通道的 ChatGPT Web 高档 (High)。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false
  },
  {
    slug: "chatgpt-web/gpt-6-light",
    displayName: "ChatGPT Web — GPT-6 Instant (即时)",
    description: "通过原生 Codex 通道的 ChatGPT GPT-6 即时档（Plus 选择器，2026-10 / GPT-6 Instant）。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_GPT6_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false
  },
  {
    slug: "chatgpt-web/gpt-6-medium",
    displayName: "ChatGPT Web — GPT-6 Medium (中等)",
    description: "通过原生 Codex 通道的 ChatGPT GPT-6 中等档（Plus 选择器，2026-10 / GPT-6 Medium）。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_GPT6_BACKEND_MODEL,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false
  },
  {
    slug: "chatgpt-web/gpt-6-high",
    displayName: "ChatGPT Web — GPT-6 High (高)",
    description: "通过原生 Codex 通道的 ChatGPT GPT-6 高档（Plus 选择器，2026-10 / GPT-6 High）。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_GPT6_BACKEND_MODEL,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High (超高)",
    description: "按账号开放的超高档 ChatGPT Web (Extra High，通过原生 Codex 通道)。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: true
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "按账号开放的 ChatGPT Pro (通过原生 Codex 通道)。",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true
  }
];
var routesBySlug = new Map([
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  ...CHATGPT_WEB_LUNA_MODEL_ROUTES,
  ...CHATGPT_WEB_MODEL_ROUTES
].map((route) => [route.slug, route]));
function isChatGptWebModelSlug(modelId) {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}
function availableChatGptWebModelRoutes(capabilities) {
  if (capabilities.browserInteractionMode === "manual") {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    return capabilities.zeroRiskProEnabled ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE] : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE];
  }
  if (!capabilities.solAvailable)
    return CHATGPT_WEB_LUNA_MODEL_ROUTES;
  return capabilities.proAvailable ? CHATGPT_WEB_MODEL_ROUTES : CHATGPT_WEB_MODEL_ROUTES.filter((route) => !route.requiresPro);
}
function requireChatGptWebModelRoute(modelId, capabilities) {
  if (capabilities.browserInteractionMode === "manual" && capabilities.experimentalBiggerContext) {
    throw new Error("Zero Risk does not support Bigger Context");
  }
  const route = routesBySlug.get(modelId);
  if (!route)
    throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (capabilities.browserInteractionMode === "manual") {
    if (route.interactionMode !== "manual") {
      throw new Error(`${route.displayName} is not available while Zero Risk is enabled`);
    }
    if (route === CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE && !capabilities.zeroRiskProEnabled) {
      throw new Error(`${route.displayName} is not enabled in Zero Risk model settings`);
    }
    return route;
  }
  if (route.interactionMode === "manual") {
    throw new Error(`${route.displayName} is only available while Zero Risk is enabled`);
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error(`${route.displayName} is only available for Luna-only accounts`);
    }
    return route;
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if (route.requiresPro && !capabilities.proAvailable) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return route;
}

// src/version.ts
var VERSION = "1.0.5";

// src/config.ts
var CHATGPT_CONNECTOR_NAME = "Codex Native2";
var DEV_CHATGPT_CONNECTOR_NAME = `${CHATGPT_CONNECTOR_NAME} DEV`;
var ZERO_RISK_CHATGPT_CONNECTOR_NAME = "Codex Zero Risk";
var LEGACY_CHATGPT_CONNECTOR_NAMES = ["Codex Native"];
function isLegacyChatGptConnectorName(value) {
  return LEGACY_CHATGPT_CONNECTOR_NAMES.includes(value);
}
function legacyChatGptConnectorMigrationMessage(legacyName) {
  return `Legacy ChatGPT connector ${JSON.stringify(legacyName)} was found, but this release requires` + ` a newly created connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}. Create` + ` ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the same tunnel with Authentication set to None;` + ` do not rename or refresh ${JSON.stringify(legacyName)}.`;
}
function resolveSetupConnectorName(existingName, requestedName) {
  if (requestedName !== undefined) {
    const requested = requestedName.trim();
    if (!requested || requested.length > 80)
      throw new Error("Connector name is invalid");
    if (requested === ZERO_RISK_CHATGPT_CONNECTOR_NAME) {
      throw new Error(`Automatic connector name ${JSON.stringify(requested)} is reserved for Zero Risk; choose a different name`);
    }
    if (isLegacyChatGptConnectorName(requested)) {
      throw new Error(legacyChatGptConnectorMigrationMessage(requested));
    }
    return requested;
  }
  const existing = existingName?.trim();
  if (!existing || existing === ZERO_RISK_CHATGPT_CONNECTOR_NAME || isLegacyChatGptConnectorName(existing))
    return CHATGPT_CONNECTOR_NAME;
  return existing;
}
function resolveDevSetupConnectorName(existingName, requestedName) {
  if (requestedName !== undefined)
    return resolveSetupConnectorName(existingName, requestedName);
  const existing = existingName?.trim();
  if (!existing || existing === CHATGPT_CONNECTOR_NAME || existing === ZERO_RISK_CHATGPT_CONNECTOR_NAME || isLegacyChatGptConnectorName(existing)) {
    return DEV_CHATGPT_CONNECTOR_NAME;
  }
  return resolveSetupConnectorName(existing);
}
function resolveInteractionConnectorIdentities(existing, interactionMode, requestedAutomaticName) {
  const previousAutomaticName = existing?.automaticAppName || (existing?.browserInteractionMode !== "manual" ? existing?.appName : undefined);
  const automaticAppName = resolveSetupConnectorName(previousAutomaticName, requestedAutomaticName);
  return {
    appName: interactionMode === "manual" ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : automaticAppName,
    automaticAppName,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME
  };
}
var CHATGPT_WEB_TUNING_DEFAULTS = {
  responseDomGraceMs: 60000,
  responseDomGraceMaxMs: 240000,
  responseDomGracePerCharMs: 2.5,
  sendEnableGraceMs: 5000
};
function resolveChatGptWebTuning(tuning) {
  const resolved = { ...CHATGPT_WEB_TUNING_DEFAULTS };
  if (!tuning)
    return resolved;
  const pick = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  if (typeof tuning.composerCharLimit === "number" && Number.isFinite(tuning.composerCharLimit) && tuning.composerCharLimit > 0) {
    resolved.composerCharLimit = tuning.composerCharLimit;
  }
  resolved.responseDomGraceMs = pick(tuning.responseDomGraceMs, resolved.responseDomGraceMs);
  resolved.responseDomGraceMaxMs = pick(tuning.responseDomGraceMaxMs, resolved.responseDomGraceMaxMs);
  resolved.responseDomGracePerCharMs = pick(tuning.responseDomGracePerCharMs, resolved.responseDomGracePerCharMs);
  resolved.sendEnableGraceMs = pick(tuning.sendEnableGraceMs, resolved.sendEnableGraceMs);
  if (typeof tuning.turnTimeoutMs === "number" && Number.isFinite(tuning.turnTimeoutMs) && tuning.turnTimeoutMs > 0) {
    resolved.turnTimeoutMs = tuning.turnTimeoutMs;
  }
  return resolved;
}
function validateChatGptWebTuning(value, path = "config") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid tuning in ${path}`);
  }
  const record = value;
  const keys = Object.keys(record);
  if (keys.length === 0)
    throw new Error(`Invalid tuning in ${path}`);
  const tuning = {};
  for (const key of keys) {
    if (key !== "turnTimeoutMs" && key !== "composerCharLimit" && !Object.keys(CHATGPT_WEB_TUNING_DEFAULTS).includes(key)) {
      throw new Error(`Unknown tuning key ${key} in ${path}`);
    }
    const num = record[key];
    if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
      throw new Error(`Invalid tuning.${key} in ${path}`);
    }
    tuning[key] = num;
  }
  if (tuning.responseDomGraceMaxMs !== undefined && (tuning.responseDomGraceMs ?? CHATGPT_WEB_TUNING_DEFAULTS.responseDomGraceMs) > tuning.responseDomGraceMaxMs) {
    throw new Error(`Invalid tuning in ${path}: responseDomGraceMs must not exceed responseDomGraceMaxMs`);
  }
  return tuning;
}
function tunnelConfigForInteractionMode(config, mode = config.browserInteractionMode) {
  const configured = mode === "manual" ? config.manualTunnel : config.automaticTunnel;
  if (configured)
    return configured;
  if (config.automaticTunnel || config.manualTunnel)
    return;
  return mode === "automatic" ? config.tunnel : undefined;
}
function expandUserPath(value) {
  if (value === "~")
    return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return join(homedir(), value.slice(2));
  return value;
}
function getConfigDir() {
  const configured = (process.env.DSH_CHATGPT_FREE_HOME || process.env.DSH_CHATGPT_WEB_HOME)?.trim();
  if (configured)
    return resolve(expandUserPath(configured));
  const dshStorage = join(homedir(), ".dsh", "storages", "chatgpt-web");
  const legacyDshStorage = join(homedir(), ".dsh", "storages", "chatgpt-free");
  const legacyStorage = join(homedir(), ".codex-chatgpt-web");
  if (!existsSync(dshStorage)) {
    if (existsSync(legacyDshStorage))
      return resolve(legacyDshStorage);
    if (existsSync(legacyStorage))
      return resolve(legacyStorage);
  }
  return resolve(dshStorage);
}
function getConfigPath() {
  return join(getConfigDir(), "config.json");
}
function isWindowsPipeEndpoint(value) {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}
function defaultBrokerEndpoint(home = getConfigDir(), platform = process.platform) {
  if (platform !== "win32")
    return join(home, "runtime", "turn-broker.sock");
  const identity = createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 20);
  return `\\\\.\\pipe\\dsh-chatgpt-web-${identity}`;
}
function resolveBrokerEndpoint(value) {
  const expanded = expandUserPath(value);
  return isWindowsPipeEndpoint(expanded) ? expanded : resolve(expanded);
}
var atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
var WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500];
function renameAtomicFile(source, destination) {
  for (let attempt = 0;; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = error.code;
      const transientWindowsError = process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined)
        throw error;
      Atomics.wait(atomicWaitCell, 0, 0, delay);
    }
  }
}
function atomicWriteFile(path, data) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 448 });
  try {
    chmodSync(directory, 448);
  } catch {}
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 384);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameAtomicFile(temp, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try {
    chmodSync(path, 384);
  } catch {}
}
function stripUtf8Bom(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}
function preserveUtf8Bom(text, original) {
  return original.startsWith("\uFEFF") ? `\uFEFF${stripUtf8Bom(text)}` : stripUtf8Bom(text);
}
function defaultConfig(mode = "browser-only") {
  const home = getConfigDir();
  return {
    version: 3,
    releaseVersion: VERSION,
    mode,
    subagentProtocol: "compatibility-v1",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256000,
    appName: CHATGPT_CONNECTOR_NAME,
    automaticAppName: CHATGPT_CONNECTOR_NAME,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    browserHost: "managed-chrome",
    browserInteractionMode: "automatic",
    chromeExecutablePath: defaultChromeExecutable(),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
    headed: false,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
    zeroRiskProEnabled: false,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
    mcpToken: randomBytes(32).toString("base64url"),
    runtimeCommand: currentRuntimeCommand()
  };
}
function currentRuntimeCommand() {
  const executableName = basename(process.execPath).toLowerCase();
  const bunExecutable = executableName === "bun" || executableName === "bun.exe" ? installedBunExecutable() : undefined;
  return runtimeCommandForProcess({
    launcher: process.env.DSH_CHATGPT_FREE_LAUNCHER,
    executable: process.execPath,
    entry: typeof Bun !== "undefined" ? Bun.main : process.argv[1],
    bunExecutable
  });
}
function installedBunExecutable({
  platform = process.platform,
  pathValue = process.env.PATH || process.env.Path || "",
  candidates = []
} = {}) {
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathCandidates = pathValue.split(pathDelimiter).map((part) => part.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean).map((part) => join(part, executableName));
  const discovered = [
    process.env.DSH_CHATGPT_FREE_BUN,
    process.env.DSH_CHATGPT_WEB_BUN,
    ...candidates,
    ...pathCandidates,
    typeof Bun !== "undefined" ? Bun.which("bun") : undefined,
    process.execPath
  ];
  for (const candidate of discovered) {
    if (!candidate?.trim())
      continue;
    const executable = resolve(candidate.trim());
    try {
      assertDurableRuntimeCommand([executable]);
      return executable;
    } catch {}
  }
  throw new Error("A durable installed Bun executable was not found outside temporary directories");
}
function runtimeCommandForProcess({
  launcher,
  executable,
  entry,
  bunExecutable
}) {
  launcher = launcher?.trim();
  if (launcher) {
    const command = [resolve(launcher)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  executable = resolve(executable);
  const executableName = basename(executable).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    if (!entry || entry.endsWith("/[eval]") || entry === "[eval]") {
      throw new Error("Cannot install a service from an evaluated Bun script");
    }
    const command = [resolve(bunExecutable?.trim() || executable), resolve(entry)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  if (executableName === "node" || executableName === "node.exe") {
    if (!entry || !isAbsolute(entry)) {
      throw new Error("Node runtime requires an absolute CLI entry path");
    }
    const command = [executable, resolve(entry)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  const command = [executable];
  assertDurableRuntimeCommand(command);
  return command;
}
function inside(path, root) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}
function assertDurableRuntimeCommand(command) {
  if (command.length === 0)
    throw new Error("Runtime command is empty");
  const executable = command[0];
  if (!isAbsolute(executable))
    throw new Error(`Runtime executable must be absolute: ${executable}`);
  const ephemeralRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  for (const part of command) {
    if (!isAbsolute(part))
      continue;
    if (ephemeralRoots.some((root) => inside(part, root))) {
      throw new Error(`Runtime command must not reference an ephemeral path: ${part}`);
    }
  }
  if (!existsSync(executable))
    throw new Error(`Runtime executable does not exist: ${executable}`);
}
function defaultChromeExecutable(platform = process.platform, programFiles = process.env.PROGRAMFILES) {
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (platform === "win32") {
    return win32.join(programFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  }
  return "/usr/bin/google-chrome";
}
function loadConfig() {
  const path = getConfigPath();
  if (!existsSync(path))
    throw new Error(`Configuration is missing: ${path}. Run dsh-chatgpt-web setup first.`);
  return parseConfig(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))), path);
}
function loadConfigForSetup() {
  const path = getConfigPath();
  if (!existsSync(path))
    throw new Error(`Configuration is missing: ${path}. Run dsh-chatgpt-web setup first.`);
  const raw = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8")));
  if (raw.version === 1 && raw.mode === "pro-only") {
    raw.version = 2;
    raw.mode = "browser-only";
  }
  if (raw.version === 2) {
    raw.version = 3;
    raw.browserHost = "managed-chrome";
  }
  const interactionMode = raw.browserInteractionMode ?? "automatic";
  const automaticName = raw.automaticAppName ?? (interactionMode === "automatic" ? raw.appName : CHATGPT_CONNECTOR_NAME);
  if (automaticName === ZERO_RISK_CHATGPT_CONNECTOR_NAME) {
    raw.automaticAppName = CHATGPT_CONNECTOR_NAME;
    if (interactionMode === "automatic")
      raw.appName = CHATGPT_CONNECTOR_NAME;
  }
  return parseConfig(raw, path);
}
function parseConfig(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid configuration object in ${path}`);
  const parsed = value;
  if (parsed.version !== 3)
    throw new Error(`Unsupported configuration version in ${path}; rerun setup to migrate it`);
  if (parsed.purpose !== undefined && parsed.purpose !== "dev-harness" && parsed.purpose !== "dsh") {
    throw new Error(`Invalid configuration purpose in ${path}`);
  }
  if (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion.trim())
    throw new Error(`Missing releaseVersion in ${path}`);
  if (parsed.mode !== "browser-only" && parsed.mode !== "full")
    throw new Error(`Invalid runtime mode in ${path}`);
  const subagentProtocol = parsed.subagentProtocol ?? "compatibility-v1";
  if (subagentProtocol !== "compatibility-v1" && subagentProtocol !== "native") {
    throw new Error(`Invalid subagentProtocol in ${path}`);
  }
  if (parsed.host !== "127.0.0.1")
    throw new Error("The Responses proxy must bind to 127.0.0.1");
  if (parsed.browserHost !== "managed-chrome" && parsed.browserHost !== "launcher") {
    throw new Error(`Invalid browserHost in ${path}`);
  }
  const browserInteractionMode = parsed.browserInteractionMode ?? "automatic";
  if (browserInteractionMode !== "automatic" && browserInteractionMode !== "manual") {
    throw new Error(`Invalid browserInteractionMode in ${path}`);
  }
  if (browserInteractionMode === "manual" && parsed.mode !== "full") {
    throw new Error(`Zero Risk requires full mode in ${path}`);
  }
  if (browserInteractionMode === "manual" && parsed.browserHost !== "launcher") {
    throw new Error(`Zero Risk requires the launcher browser host in ${path}`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535)
    throw new Error(`Invalid port in ${path}`);
  if (!Number.isSafeInteger(parsed.contextWindow) || parsed.contextWindow <= 0) {
    throw new Error(`Invalid contextWindow in ${path}`);
  }
  if (typeof parsed.headed !== "boolean")
    throw new Error(`Invalid headed in ${path}`);
  if (typeof parsed.autoApproveToolCalls !== "boolean") {
    throw new Error(`Invalid autoApproveToolCalls in ${path}`);
  }
  const requiredStrings = [
    "appName",
    "chromeExecutablePath",
    "storageStatePath",
    "brokerSocketPath",
    "controlToken"
  ];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !parsed[key].trim())
      throw new Error(`Missing ${key} in ${path}`);
  }
  if (parsed.appName.length > 80)
    throw new Error(`appName is too long in ${path}`);
  const automaticAppName = parsed.automaticAppName ?? (browserInteractionMode === "automatic" ? parsed.appName : CHATGPT_CONNECTOR_NAME);
  const manualAppName = parsed.manualAppName ?? ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  if (typeof automaticAppName !== "string" || !automaticAppName.trim() || automaticAppName.length > 80) {
    throw new Error(`Invalid automaticAppName in ${path}`);
  }
  if (manualAppName !== ZERO_RISK_CHATGPT_CONNECTOR_NAME) {
    throw new Error(`manualAppName must be ${JSON.stringify(ZERO_RISK_CHATGPT_CONNECTOR_NAME)} in ${path}`);
  }
  if (automaticAppName === manualAppName) {
    throw new Error(`Automatic and Zero Risk connector names must differ in ${path}; rerun setup`);
  }
  const expectedAppName = browserInteractionMode === "manual" ? manualAppName : automaticAppName;
  if (parsed.appName !== expectedAppName) {
    throw new Error(`Active appName does not match browserInteractionMode in ${path}; rerun setup`);
  }
  if (parsed.browserHost === "launcher" && (typeof parsed.browserHostDescriptorPath !== "string" || !parsed.browserHostDescriptorPath.trim())) {
    throw new Error(`Launcher browser host requires browserHostDescriptorPath in ${path}`);
  }
  if (parsed.browserHost === "launcher" && !isAbsolute(expandUserPath(parsed.browserHostDescriptorPath))) {
    throw new Error(`Launcher browserHostDescriptorPath must be absolute in ${path}`);
  }
  const brokerEndpoint = expandUserPath(parsed.brokerSocketPath);
  if (process.platform === "win32") {
    if (!isWindowsPipeEndpoint(brokerEndpoint)) {
      throw new Error(`Windows brokerSocketPath must be a named pipe in ${path}`);
    }
  } else if (!isAbsolute(brokerEndpoint) || isWindowsPipeEndpoint(brokerEndpoint)) {
    throw new Error(`brokerSocketPath must be an absolute Unix socket path in ${path}`);
  }
  if (!/^[A-Za-z0-9_-]{40,}$/.test(parsed.controlToken))
    throw new Error(`Invalid controlToken in ${path}`);
  if (parsed.mcpToken !== undefined && (typeof parsed.mcpToken !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(parsed.mcpToken))) {
    throw new Error(`Invalid mcpToken in ${path}`);
  }
  const validateTunnel = (tunnel, label) => {
    if (!tunnel || typeof tunnel !== "object")
      throw new Error(`${label} is missing in ${path}`);
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"]) {
      if (typeof tunnel[key] !== "string" || !tunnel[key].trim()) {
        throw new Error(`Missing ${label}.${key} in ${path}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)) {
      throw new Error(`Invalid ${label}.tunnelId in ${path}`);
    }
    for (const key of ["profileName", "alias"]) {
      if (!/^[A-Za-z0-9._-]+$/.test(tunnel[key])) {
        throw new Error(`Invalid ${label}.${key} in ${path}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"]) {
      if (!isAbsolute(expandUserPath(tunnel[key]))) {
        throw new Error(`${label}.${key} must be absolute in ${path}`);
      }
    }
  };
  if (parsed.mode === "full") {
    validateTunnel(parsed.tunnel, "tunnel");
    if (parsed.automaticTunnel !== undefined)
      validateTunnel(parsed.automaticTunnel, "automaticTunnel");
    if (parsed.manualTunnel !== undefined)
      validateTunnel(parsed.manualTunnel, "manualTunnel");
    if (parsed.automaticTunnel && parsed.manualTunnel && parsed.automaticTunnel.tunnelId === parsed.manualTunnel.tunnelId) {
      throw new Error(`Automatic and Zero Risk must use different Tunnel IDs in ${path}`);
    }
    const activeTunnel = browserInteractionMode === "manual" ? parsed.manualTunnel : parsed.automaticTunnel;
    if ((parsed.automaticTunnel || parsed.manualTunnel) && !activeTunnel) {
      throw new Error(`Active browser interaction mode has no tunnel configuration in ${path}`);
    }
    if (activeTunnel && JSON.stringify(activeTunnel) !== JSON.stringify(parsed.tunnel)) {
      throw new Error(`Active tunnel does not match browserInteractionMode in ${path}; rerun MCP setup`);
    }
  }
  if (!Array.isArray(parsed.runtimeCommand) || parsed.runtimeCommand.length === 0 || parsed.runtimeCommand.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error(`Invalid runtimeCommand in ${path}`);
  }
  assertDurableRuntimeCommand(parsed.runtimeCommand);
  if (parsed.proAvailable !== undefined && typeof parsed.proAvailable !== "boolean") {
    throw new Error(`Invalid proAvailable in ${path}`);
  }
  if (parsed.solAvailable !== undefined && typeof parsed.solAvailable !== "boolean") {
    throw new Error(`Invalid solAvailable in ${path}`);
  }
  if (parsed.experimentalBiggerContext !== undefined && typeof parsed.experimentalBiggerContext !== "boolean") {
    throw new Error(`Invalid experimentalBiggerContext in ${path}`);
  }
  if (parsed.zeroRiskProEnabled !== undefined && typeof parsed.zeroRiskProEnabled !== "boolean") {
    throw new Error(`Invalid zeroRiskProEnabled in ${path}`);
  }
  if (parsed.stallTimeoutSec !== undefined && (!Number.isFinite(parsed.stallTimeoutSec) || parsed.stallTimeoutSec <= 0)) {
    throw new Error(`Invalid stallTimeoutSec in ${path}`);
  }
  if (parsed.tuning !== undefined) {
    parsed.tuning = validateChatGptWebTuning(parsed.tuning, path);
  }
  if (parsed.externalMcp !== undefined) {
    const external = parsed.externalMcp;
    if (!external || typeof external !== "object" || Array.isArray(external)) {
      throw new Error(`Invalid externalMcp in ${path}`);
    }
    if (typeof external.connectorName !== "string" || external.connectorName.trim().length === 0 || external.connectorName.trim().length > 80) {
      throw new Error(`Invalid externalMcp.connectorName in ${path}`);
    }
    if (typeof external.serverName !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(external.serverName.trim())) {
      throw new Error(`Invalid externalMcp.serverName in ${path}`);
    }
    if (typeof external.workspace !== "string" || !isAbsolute(expandUserPath(external.workspace))) {
      throw new Error(`externalMcp.workspace must be absolute in ${path}`);
    }
    if (external.sandboxPolicy !== "dangerFullAccess" && external.sandboxPolicy !== "workspaceWrite" && external.sandboxPolicy !== "readOnly") {
      throw new Error(`Invalid externalMcp.sandboxPolicy in ${path}`);
    }
    if (external.networkAccess !== undefined && typeof external.networkAccess !== "boolean") {
      throw new Error(`Invalid externalMcp.networkAccess in ${path}`);
    }
    if (browserInteractionMode === "manual") {
      throw new Error(`externalMcp is unavailable while Zero Risk is enabled in ${path}`);
    }
    parsed.externalMcp = {
      connectorName: external.connectorName.trim(),
      serverName: external.serverName.trim(),
      workspace: expandUserPath(external.workspace),
      sandboxPolicy: external.sandboxPolicy,
      ...external.networkAccess !== undefined ? { networkAccess: external.networkAccess } : {}
    };
  }
  if (parsed.toolGateway !== undefined) {
    const gateway = parsed.toolGateway;
    if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
      throw new Error(`Invalid toolGateway in ${path}`);
    }
    const mcp = gateway.mcp;
    if (mcp !== undefined) {
      if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
        throw new Error(`Invalid toolGateway.mcp in ${path}`);
      }
      if (mcp.transport !== "stdio" && mcp.transport !== "http") {
        throw new Error(`toolGateway.mcp.transport must be stdio or http in ${path}`);
      }
      if (mcp.transport === "stdio" && (typeof mcp.command !== "string" || mcp.command.trim().length === 0)) {
        throw new Error(`toolGateway.mcp.command is required for stdio in ${path}`);
      }
      if (mcp.transport === "http" && (typeof mcp.url !== "string" || !/^https?:\/\//.test(mcp.url))) {
        throw new Error(`toolGateway.mcp.url must be an absolute HTTP(S) URL in ${path}`);
      }
      if (mcp.namePrefix !== undefined && typeof mcp.namePrefix !== "string") {
        throw new Error(`toolGateway.mcp.namePrefix must be a string in ${path}`);
      }
    }
  }
  const solAvailable = parsed.solAvailable !== false;
  const proAvailable = parsed.proAvailable === true;
  const experimentalBiggerContext = parsed.experimentalBiggerContext === true;
  const zeroRiskProEnabled = parsed.zeroRiskProEnabled === true;
  if (browserInteractionMode === "manual" && experimentalBiggerContext) {
    throw new Error(`Zero Risk does not support Bigger Context in ${path}`);
  }
  if (proAvailable && !solAvailable) {
    throw new Error(`Invalid ChatGPT account capabilities in ${path}: Pro requires Sol`);
  }
  return {
    ...parsed,
    appName: expectedAppName,
    automaticAppName,
    manualAppName,
    browserInteractionMode,
    subagentProtocol,
    solAvailable,
    proAvailable,
    experimentalBiggerContext,
    zeroRiskProEnabled
  };
}
function saveConfig(config) {
  const path = getConfigPath();
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWriteFile(path, preserveUtf8Bom(`${JSON.stringify(config, null, 2)}
`, original));
}
function providerConfig(config) {
  const manual = config.browserInteractionMode === "manual";
  const externalMcp = manual ? undefined : config.externalMcp;
  const model = manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : config.solAvailable ? "gpt-5.6-sol" : "gpt-5.6-luna";
  const models = manual ? [
    CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
    ...config.zeroRiskProEnabled ? [CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL] : []
  ] : [model];
  const efforts = manual ? ["low"] : config.solAvailable ? ["low", "medium", "high", "xhigh", ...config.proAvailable ? ["max"] : []] : ["low", "medium"];
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: model,
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(models.map((model) => [model, manual ? ["text"] : ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(models.map((modelId) => [modelId, efforts])),
    modelDefaultReasoningEfforts: Object.fromEntries(models.map((modelId) => [modelId, manual ? "low" : config.solAvailable ? "high" : "low"])),
    noReasoningModels: [],
    chatgptWeb: {
      appName: manual ? config.manualAppName : externalMcp?.connectorName ?? config.automaticAppName,
      browserInteractionMode: config.browserInteractionMode,
      browserHost: config.browserHost,
      browserHostDescriptorPath: config.browserHostDescriptorPath,
      storageStatePath: config.storageStatePath,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      lunaCheckpointStatePath: join(getConfigDir(), "runtime", "luna-checkpoints.json"),
      headed: config.headed,
      localToolsEnabled: config.mode === "full" || externalMcp !== undefined,
      ...externalMcp ? {
        externalMcp: {
          connectorName: externalMcp.connectorName,
          serverName: externalMcp.serverName,
          workspace: resolve(expandUserPath(externalMcp.workspace)),
          sandboxPolicy: externalMcp.sandboxPolicy,
          ...externalMcp.networkAccess !== undefined ? { networkAccess: externalMcp.networkAccess } : {}
        }
      } : {},
      solAvailable: manual ? false : config.solAvailable,
      proAvailable: manual ? false : config.proAvailable,
      experimentalBiggerContext: manual ? false : config.experimentalBiggerContext,
      ...config.stallTimeoutSec !== undefined ? { stallTimeoutSec: config.stallTimeoutSec } : {},
      ...config.tuning !== undefined ? { tuning: config.tuning } : {},
      autoApproveToolCalls: manual ? false : config.autoApproveToolCalls
    }
  };
}

// src/plugin.ts
import { pathToFileURL } from "node:url";
var name = "dsh-chatgpt-web";
var inject = [];
var ROOT_DIR = resolve2(dirname2(fileURLToPath(import.meta.url)), "..");
function resolveLauncher(customBunPath) {
  const libCliPath = resolve2(ROOT_DIR, "lib", "cli.js");
  if (existsSync2(libCliPath)) {
    return {
      cmd: process.execPath,
      args: [libCliPath, "serve"]
    };
  }
  if (customBunPath && existsSync2(customBunPath)) {
    return { cmd: customBunPath, args: ["run", "src/cli.ts", "serve"] };
  }
  const winBun = join2(homedir2(), ".bun", "bin", "bun.exe");
  if (existsSync2(winBun)) {
    return { cmd: winBun, args: ["run", "src/cli.ts", "serve"] };
  }
  try {
    const tsxUrl = import.meta.resolve("tsx");
    return {
      cmd: process.execPath,
      args: ["--import", tsxUrl, "src/cli.ts", "serve"]
    };
  } catch {}
  const localTsx = resolve2(ROOT_DIR, "node_modules/tsx/dist/esm/index.mjs");
  if (existsSync2(localTsx)) {
    return {
      cmd: process.execPath,
      args: ["--import", pathToFileURL(localTsx).href, "src/cli.ts", "serve"]
    };
  }
  const siblingTsx = resolve2(ROOT_DIR, "../deepseek-harness/node_modules/tsx/dist/esm/index.mjs");
  if (existsSync2(siblingTsx)) {
    return {
      cmd: process.execPath,
      args: ["--import", pathToFileURL(siblingTsx).href, "src/cli.ts", "serve"]
    };
  }
  return { cmd: process.execPath, args: ["src/cli.ts", "serve"] };
}
async function isSidecarHealthy(host, port) {
  try {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok)
      return false;
    const body = await res.json();
    return body.status === "ok";
  } catch {
    return false;
  }
}
function apply(ctx, config = {}) {
  const host = config.host || "127.0.0.1";
  const port = config.port || 17841;
  const autoStart = config.autoStart !== false;
  const readyTimeoutMs = config.readyTimeoutMs || 30000;
  const logger = typeof ctx.logger === "function" ? ctx.logger("chatgpt-web") : console;
  const turns = new Map;
  const sidecarTurns = new Map;
  ctx.on?.("session/event", (session, event) => {
    const sessionId = String(session.id);
    if (event.type === "turn/start" && Number.isSafeInteger(event.data?.turn)) {
      turns.set(sessionId, event.data.turn);
    }
    if (event.type !== "turn/end")
      return;
    if (turns.get(sessionId) === event.data?.turn)
      turns.delete(sessionId);
    const turn = sidecarTurns.get(sessionId);
    if (turn === undefined || turn !== event.data?.turn)
      return;
    sidecarTurns.delete(sessionId);
    if (!["aborted", "error", "blocked", "max-tokens"].includes(event.data?.reason?.kind))
      return;
    return (async () => {
      try {
        const response = await fetch(`http://${host}:${port}/admin/interrupt-turn`, {
          method: "POST",
          signal: AbortSignal.timeout(5000),
          headers: { "content-type": "application/json", Authorization: `Bearer ${loadConfig().controlToken}` },
          body: JSON.stringify({ threadId: `dsh-${sessionId}`, turnId: `dsh-turn-${turn}` })
        });
        if (!response.ok)
          throw new Error(`sidecar returned HTTP ${response.status}`);
      } catch (error) {
        logger.warn(`[dsh-chatgpt-web] Could not forward turn termination: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });
  ctx.on?.("llm-pi-ai/request-headers", (request, headers, next) => {
    const result = next();
    let endpoint;
    try {
      endpoint = new URL(request.baseURL);
    } catch {
      return result;
    }
    if (endpoint.hostname !== host || endpoint.port !== String(port))
      return result;
    if (request.sessionId !== undefined)
      result.set("x-dsh-session-id", String(request.sessionId));
    const sessionId = String(request.sessionId);
    const turn = turns.get(sessionId);
    if (turn !== undefined) {
      result.set("x-dsh-turn-id", `dsh-turn-${turn}`);
      sidecarTurns.set(sessionId, turn);
    }
    if (request.purpose !== undefined)
      result.set("x-dsh-request-purpose", String(request.purpose));
    return result;
  });
  let spawnedProcess;
  const installedStack = join2(homedir2(), ".local", "share", "dsh-web-stack", "stack.py");
  const stackCommand = config.stackCommand ?? (host === "127.0.0.1" && port === 17841 && existsSync2(installedStack) ? ["python3", installedStack] : undefined);
  let disposed = false;
  const startDaemon = async () => {
    if (stackCommand?.length && autoStart) {
      const child = spawn(stackCommand[0], [...stackCommand.slice(1), "ensure", "--client-pid", String(process.pid)], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      });
      child.stderr?.on("data", (chunk) => logger.warn(`[stack] ${chunk.toString().trim()}`));
      child.on("error", (error) => logger.error(`[dsh-chatgpt-web] Stack supervisor failed: ${error.message}`));
      child.on("exit", (code) => {
        if (code && !disposed)
          logger.error(`[dsh-chatgpt-web] Stack supervisor readiness failed (exit ${code})`);
      });
      return;
    }
    const alreadyHealthy = await isSidecarHealthy(host, port);
    if (alreadyHealthy) {
      logger.info(`[dsh-chatgpt-web] Sidecar already running and healthy at http://${host}:${port}/v1`);
      return;
    }
    if (!autoStart) {
      logger.warn(`[dsh-chatgpt-web] Sidecar is offline and autoStart is false. Start it manually with 'bun run src/cli.ts serve'`);
      return;
    }
    const launcher = resolveLauncher(config.bunPath);
    logger.info(`[dsh-chatgpt-web] Starting dsh-chatgpt-web daemon via ${launcher.cmd} at http://${host}:${port}/v1...`);
    const child = spawn(launcher.cmd, launcher.args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env
      }
    });
    spawnedProcess = child;
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function")
        logger.debug(`[sidecar] ${text}`);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function")
        logger.debug(`[sidecar:err] ${text}`);
    });
    child.on("error", (err) => {
      logger.error(`[dsh-chatgpt-web] Failed to launch sidecar process: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn(`[dsh-chatgpt-web] Sidecar process exited with code ${code} (signal: ${signal})`);
      }
      spawnedProcess = undefined;
    });
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await isSidecarHealthy(host, port)) {
        logger.info(`[dsh-chatgpt-web] Sidecar ready and accepting turns at http://${host}:${port}/v1`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    logger.error(`[dsh-chatgpt-web] Sidecar did not become healthy within ${readyTimeoutMs}ms`);
  };
  const stopDaemon = async () => {
    disposed = true;
    if (stackCommand?.length)
      return;
    if (!spawnedProcess)
      return;
    logger.info("[dsh-chatgpt-web] Stopping sidecar daemon...");
    try {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(`http://${host}:${port}/admin/shutdown`, {
        method: "POST",
        signal: controller.signal
      }).catch(() => {});
      clearTimeout(timer);
    } catch {}
    if (spawnedProcess && !spawnedProcess.killed) {
      spawnedProcess.kill("SIGTERM");
    }
    spawnedProcess = undefined;
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      startDaemon();
      return () => {
        stopDaemon();
      };
    });
  } else {
    startDaemon();
    process.once("beforeExit", () => void stopDaemon());
  }
}
var plugin_default = {
  name,
  inject,
  apply
};
export {
  apply,
  plugin_default as default,
  inject,
  name
};
