import { watch, watchFile, unwatchFile, type Stats } from "node:fs";
import { loadConfig, type AppConfig } from "./config";

/**
 * Fields that describe the listening process itself. Changing them cannot be applied to a live
 * listener without rebinding, so they stay on the old values and the file is the source of truth
 * for the next process start.
 */
export const RESTART_REQUIRED_CONFIG_FIELDS = ["host", "port", "mode", "purpose", "brokerSocketPath"] as const;

/**
 * Fields that affect the browser worker configuration, the tool executor, or the browser
 * lifecycle. Applying them is safe for new turns, but existing workers must be retired once no
 * turn is active so the new configuration is used without interrupting anyone.
 */
export const WORKER_RESET_CONFIG_FIELDS = new Set<string>([
  "chromeExecutablePath",
  "storageStatePath",
  "headed",
  "browserHost",
  "browserHostDescriptorPath",
  "browserInteractionMode",
  "autoApproveToolCalls",
  "tuning",
  "stallTimeoutSec",
  "toolGateway",
  "externalMcp",
  "zeroRiskProEnabled",
  "solAvailable",
  "proAvailable",
  "experimentalBiggerContext",
  "contextWindow",
]);

export interface ConfigReloadPlan {
  changed: string[];
  applied: string[];
  deferred: string[];
  /** Workers must be rebuilt before the applied fields take full effect. */
  workerReset: boolean;
  noop: boolean;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Compare the live config with a freshly loaded one and decide what can be applied safely. */
export function planConfigReload(current: AppConfig, next: AppConfig): ConfigReloadPlan {
  const changed: string[] = [];
  const applied: string[] = [];
  const deferred: string[] = [];
  let workerReset = false;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of keys) {
    if (sameValue((current as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key])) continue;
    changed.push(key);
    if ((RESTART_REQUIRED_CONFIG_FIELDS as readonly string[]).includes(key)) {
      deferred.push(key);
      continue;
    }
    applied.push(key);
    if (WORKER_RESET_CONFIG_FIELDS.has(key)) workerReset = true;
  }
  return { changed, applied, deferred, workerReset, noop: changed.length === 0 };
}

/**
 * Apply a reload plan to the shared config object. The server reads `config.*` per request, so
 * mutating it is enough for new turns; restart-required fields keep their live values.
 */
export function applyConfigReload(current: AppConfig, next: AppConfig, plan = planConfigReload(current, next)): ConfigReloadPlan {
  const target = current as unknown as Record<string, unknown>;
  const source = next as unknown as Record<string, unknown>;
  for (const key of plan.applied) target[key] = source[key];
  return plan;
}

export interface ConfigReloadWatcher {
  stop(): void;
  reloadNow(): ConfigReloadPlan;
}

interface ConfigWatcherOptions {
  onReload: (next: AppConfig, plan: ConfigReloadPlan) => void;
  onError?: (error: Error) => void;
  intervalMs?: number;
  debounceMs?: number;
}

/**
 * Watch the sidecar config file and hot-apply every safe change. Validation always goes through
 * loadConfig(), so a half-written or invalid file is ignored and the previous config keeps serving.
 */
export function watchSidecarConfig(
  configPath: string,
  current: AppConfig,
  options: ConfigWatcherOptions,
): ConfigReloadWatcher {
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastSignature = `${Date.now()}:${Math.random()}`;

  const reloadNow = (): ConfigReloadPlan => {
    let next: AppConfig;
    try {
      next = loadConfig();
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return { changed: [], applied: [], deferred: [], workerReset: false, noop: true };
    }
    const plan = planConfigReload(current, next);
    if (plan.noop) return plan;
    // Recheck that the file did not change between loadConfig() and apply.
    try {
      const verified = loadConfig();
      if (!sameValue(verified, next)) return { changed: [], applied: [], deferred: [], workerReset: false, noop: true };
    } catch {
      return { changed: [], applied: [], deferred: [], workerReset: false, noop: true };
    }
    applyConfigReload(current, next, plan);
    options.onReload(next, plan);
    return plan;
  };

  const schedule = (): void => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      reloadNow();
    }, options.debounceMs ?? 250);
    debounce.unref?.();
  };

  const onStat = (stats: Stats): void => {
    const signature = `${stats.mtimeMs}:${stats.size}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    schedule();
  };
  watchFile(configPath, { interval: options.intervalMs ?? 1_000 }, onStat);

  // SIGHUP is the conventional "reload config" signal and works even on filesystems where watch
  // events are unreliable (network mounts, some containers).
  const onHangup = (): void => { schedule(); };
  process.on("SIGHUP", onHangup);

  return {
    reloadNow,
    stop() {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      unwatchFile(configPath);
      process.removeListener("SIGHUP", onHangup);
    },
  };
}

export interface CodeWatcherOptions {
  /** Directory containing the built entry points. */
  directory: string;
  onChanged: (files: string[]) => void;
  debounceMs?: number;
}

/** Watch built entry points so a fresh `bun run build` can be applied by a graceful restart. */
export function watchBuiltCode({ directory, onChanged, debounceMs = 2_000 }: CodeWatcherOptions): { stop(): void } {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const changed = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(directory, (event, filename) => {
      if (!filename || !/\.(?:js|cjs|mjs|json)$/.test(filename.toString())) return;
      changed.add(filename.toString());
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        const files = [...changed];
        changed.clear();
        onChanged(files);
      }, debounceMs);
      debounce.unref?.();
    });
    watcher.on("error", () => { /* The next build still works; watcher failure is not fatal. */ });
  } catch {
    watcher = undefined;
  }
  return {
    stop() {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
    },
  };
}
