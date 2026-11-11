import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
