import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { applyConfigReload, planConfigReload } from "../src/hot-reload";

const base = (): AppConfig => ({
  host: "127.0.0.1",
  port: 17841,
  mode: "browser-only",
  tuning: { responseDomGraceMs: 60_000 },
  chromeExecutablePath: "/usr/bin/google-chrome",
  autoApproveToolCalls: true,
} as unknown as AppConfig);

describe("config hot reload plan", () => {
  test("tuning and browser fields apply live but retire workers when idle", () => {
    const current = base();
    const next = { ...current, tuning: { responseDomGraceMs: 90_000 }, autoApproveToolCalls: false };
    const plan = planConfigReload(current, next);
    expect(plan.changed.sort()).toEqual(["autoApproveToolCalls", "tuning"]);
    expect(plan.applied.sort()).toEqual(["autoApproveToolCalls", "tuning"]);
    expect(plan.deferred).toEqual([]);
    expect(plan.workerReset).toBe(true);
    applyConfigReload(current, next, plan);
    expect(current.tuning).toEqual({ responseDomGraceMs: 90_000 });
    expect(current.autoApproveToolCalls).toBe(false);
  });

  test("listener fields are deferred until the next process start", () => {
    const current = base();
    const next = { ...current, host: "0.0.0.0", port: 18000, chromeExecutablePath: "/opt/chrome" } as unknown as AppConfig;
    const plan = planConfigReload(current, next);
    expect(plan.applied).toEqual(["chromeExecutablePath"]);
    expect(plan.deferred.sort()).toEqual(["host", "port"]);
    expect(plan.workerReset).toBe(true);
    applyConfigReload(current, next, plan);
    expect(current.host).toBe("127.0.0.1");
    expect(current.port).toBe(17841);
    expect(current.chromeExecutablePath).toBe("/opt/chrome");
  });

  test("an unchanged file is a no-op and never resets workers", () => {
    const current = base();
    const plan = planConfigReload(current, { ...current });
    expect(plan.noop).toBe(true);
    expect(plan.workerReset).toBe(false);
    expect(plan.applied).toEqual([]);
  });

  test("token and stall-timeout changes apply without a listener restart", () => {
    const current = base();
    const next = { ...current, stallTimeoutSec: 60, mcpToken: "next-token" };
    const plan = planConfigReload(current, next);
    expect(plan.deferred).toEqual([]);
    expect(plan.applied.sort()).toEqual(["mcpToken", "stallTimeoutSec"]);
    applyConfigReload(current, next, plan);
    expect(current.mcpToken).toBe("next-token");
  });
});
