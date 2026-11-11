import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error The standalone Node ESM CLI intentionally has no TS declarations.
import { analyze, compare, summarize } from "../scripts/latency-regression.mjs";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/latency-baseline.json"), "utf8"));
const candidate = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/latency-candidate.json"), "utf8"));

describe("offline latency regression analyzer", () => {
  test("groups comparable model, workload, and fresh/retained turns separately", () => {
    const report = analyze(fixture, candidate);
    expect(report.kind).toBe("synthetic-fixture");
    expect(report.comparisons).toHaveLength(2);
    expect(report.comparisons.map((c: any) => c.key.turn)).toEqual(["fresh", "retained"]);
    expect(report.comparisons[0].metrics.totalSeconds.baseline.median).toBe(10);
    expect(report.comparisons[0].metrics.totalSeconds.candidate.median).toBe(14);
    expect(report.comparisons[0].metrics.totalSeconds.regression).toBe(true);
    expect(report.comparisons[1].metrics.totalSeconds.regression).toBe(false);
  });

  test("missing fields remain unavailable instead of manufacturing zero durations", () => {
    const report = analyze(fixture, candidate);
    const fresh = report.comparisons[0];
    expect(fresh.metrics.queueWaitSeconds.status).toBe("unavailable");
    expect(fresh.metrics.toolExecutionSeconds.status).toBe("unavailable");
    expect(fresh.metrics.toFirstAnswerSeconds.status).toBe("compared");
    expect(fresh.metrics.toFirstAnswerSeconds.baseline.n).toBe(3);
  });

  test("tail metrics require adequate samples and are not extrapolated", () => {
    expect(summarize([1, 2, 3]).p95).toBeNull();
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
    expect(summarize([1, null, Number.NaN, -2, 3]).n).toBe(2);
  });

  test("small sample comparisons are report-only and flagged as insufficient", () => {
    const result = compare([1, 1], [5, 5], { relativeThreshold: 0.2, absoluteThresholdSeconds: 0.5, minSamples: 3 });
    expect(result.status).toBe("insufficient-samples");
    expect(result.regression).toBeNull();
  });

  test("compares unrounded medians against absolute and relative thresholds", () => {
    const options = { relativeThreshold: 0.2, absoluteThresholdSeconds: 0.5, minSamples: 3 };
    const flagged = compare([1, 1, 1], [1.5004, 1.5004, 1.5004], options);
    expect(flagged.deltaSeconds).toBe(0.5);
    expect(flagged.regression).toBe(true);
    const exactBoundary = compare([1, 1, 1], [1.5, 1.5, 1.5], options);
    expect(exactBoundary.regression).toBe(false);
    const belowRelative = compare([10, 10, 10], [10.5004, 10.5004, 10.5004], options);
    expect(belowRelative.regression).toBe(false);
    const fractionalBaseline = compare([1.0004, 1.0004, 1.0004], [1.5004, 1.5004, 1.5004], options);
    expect(fractionalBaseline.regression).toBe(false);
  });

  test("creates and overwrites JSON and Markdown reports with 0600 permissions", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "dsh-latency-permissions-"));
    try {
      const jsonPath = join(dir, "report.json");
      const markdownPath = join(dir, "report.md");
      const invoke = () => spawnSync(process.execPath, [
        resolve(import.meta.dir, "../scripts/latency-regression.mjs"),
        "--baseline", resolve(import.meta.dir, "fixtures/latency-baseline.json"),
        "--candidate", resolve(import.meta.dir, "fixtures/latency-candidate.json"),
        "--output", jsonPath, "--markdown", markdownPath,
      ], { encoding: "utf8" });
      const check = () => {
        expect(statSync(jsonPath).mode & 0o777).toBe(0o600);
        expect(statSync(markdownPath).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(jsonPath, "utf8")).comparisons).toHaveLength(2);
        expect(readFileSync(markdownPath, "utf8")).toContain("Latency comparison");
      };
      expect(invoke().status).toBe(0);
      check();
      writeFileSync(jsonPath, "previous content");
      writeFileSync(markdownPath, "previous content");
      chmodSync(jsonPath, 0o666);
      chmodSync(markdownPath, 0o644);
      expect(invoke().status).toBe(0);
      check();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed and sensitive data without echoing contents", () => {
    expect(() => analyze([{ model: "x", turn: "fresh", totalSeconds: -1 }], [])).toThrow();
    expect(() => analyze([{ model: "x", turn: "fresh", totalSeconds: 1, cookie: "SECRET" }], [])).toThrow(/unsupported field/);
    expect(JSON.stringify(analyze(fixture, candidate))).not.toContain("session");
  });

  test("reports nonmatching groups without pretending a comparison exists", () => {
    const result = analyze(fixture, [{ ...candidate[0], model: "different" }]);
    expect(result.unmatched.candidate).toHaveLength(1);
    expect(result.unmatched.baseline).toHaveLength(2);
  });
});
