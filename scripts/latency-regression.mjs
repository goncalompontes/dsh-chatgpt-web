#!/usr/bin/env node
/**
 * Offline, report-only latency comparison. No browser, credentials, or network access.
 * Input: sanitized per-turn results.json from measure-latency-matrix.py, or fixture rows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const METRICS = Object.freeze([
  "hostSetupSeconds", "toSendAcceptedSeconds", "toFirstAnswerSeconds",
  "totalSeconds", "queueWaitSeconds", "toolExecutionSeconds",
]);
const KEYS = Object.freeze(["stage", "case", "model", "turn", "width"]);
const ALLOWED = new Set([...KEYS, ...METRICS, "batch", "run", "retainedPage",
  "toFirstToolSeconds", "acceptedToFirstToolSeconds", "acceptedToFirstAnswerSeconds",
  "toFirstThoughtSeconds", "contextChars", "stages", "checkpoints", "job", "session"]);
const round = (value) => Math.round(value * 1000) / 1000;
const median = (values) => {
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};

export function summarize(samples) {
  const values = samples.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  return {
    n: values.length, median: round(median(values)),
    min: round(values[0]), max: round(values.at(-1)),
    // Nearest rank is meaningful only for >=20 samples; never infer p95 from n=3.
    p95: values.length >= 20 ? round(values[Math.ceil(0.95 * values.length) - 1]) : null,
  };
}

export function compare(before, after, options) {
  const baseline = summarize(before);
  const candidate = summarize(after);
  if (!baseline || !candidate) return { status: "unavailable", baseline, candidate, regression: null };
  if (baseline.n < options.minSamples || candidate.n < options.minSamples) {
    return { status: "insufficient-samples", baseline, candidate, regression: null };
  }
  const deltaSeconds = round(candidate.median - baseline.median);
  const deltaPercent = baseline.median > 0
    ? round(100 * deltaSeconds / baseline.median) : null;
  // BOTH absolute and relative thresholds must be exceeded.
  const regression = deltaSeconds > options.absoluteThresholdSeconds &&
    (baseline.median === 0 || deltaSeconds / baseline.median > options.relativeThreshold);
  return { status: "compared", baseline, candidate, deltaSeconds, deltaPercent, regression };
}

function sanitizeRow(row) {
  if (!row || Array.isArray(row) || typeof row !== "object") throw new Error("invalid timing row");
  for (const name of Object.keys(row)) {
    if (!ALLOWED.has(name)) throw new Error("unsupported field in timing row");
  }
  const key = {
    stage: row.stage ?? "serial", case: row.case ?? "read",
    model: row.model, turn: row.turn, width: row.width ?? 1,
  };
  if (typeof key.model !== "string" || !/^[a-zA-Z0-9/_-]{1,100}$/.test(key.model) ||
      !["fresh", "retained"].includes(key.turn) ||
      typeof key.stage !== "string" || !/^[a-z-]{1,40}$/.test(key.stage) ||
      typeof key.case !== "string" || !/^[a-z-]{1,40}$/.test(key.case) ||
      !Number.isSafeInteger(key.width) || key.width < 1 || key.width > 100) {
    throw new Error("invalid comparison dimensions");
  }
  const metrics = {};
  for (const metric of METRICS) {
    const value = row[metric];
    if (value !== undefined && value !== null &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error("invalid metric value");
    }
    metrics[metric] = value ?? null;
  }
  return { key, metrics };
}

function group(rows) {
  if (!Array.isArray(rows)) throw new Error("input must be an array of per-turn timing rows");
  const groups = new Map();
  for (const original of rows) {
    const row = sanitizeRow(original);
    const id = JSON.stringify(KEYS.map((name) => row.key[name]));
    if (!groups.has(id)) groups.set(id, { key: row.key, values: Object.fromEntries(METRICS.map((m) => [m, []])) });
    for (const metric of METRICS) groups.get(id).values[metric].push(row.metrics[metric]);
  }
  return groups;
}

export function analyze(baselineRows, candidateRows, options = {}) {
  const opts = {
    relativeThreshold: options.relativeThreshold ?? 0.2,
    absoluteThresholdSeconds: options.absoluteThresholdSeconds ?? 0.5,
    minSamples: options.minSamples ?? 3,
  };
  if (!Number.isFinite(opts.relativeThreshold) || opts.relativeThreshold < 0 ||
      !Number.isFinite(opts.absoluteThresholdSeconds) || opts.absoluteThresholdSeconds < 0 ||
      !Number.isSafeInteger(opts.minSamples) || opts.minSamples < 1) throw new Error("invalid thresholds");
  const baseline = group(baselineRows);
  const candidate = group(candidateRows);
  const common = [...baseline.keys()].filter((id) => candidate.has(id)).sort();
  const comparisons = common.map((id) => {
    const b = baseline.get(id);
    const c = candidate.get(id);
    return {
      key: b.key,
      metrics: Object.fromEntries(METRICS.map((m) => [m, compare(b.values[m], c.values[m], opts)])),
    };
  });
  const missing = (from, other) => [...from.entries()].filter(([id]) => !other.has(id))
    .map(([, group]) => group.key).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    schemaVersion: 1, kind: "synthetic-fixture", mode: "report-only",
    thresholds: opts, metrics: METRICS,
    comparisons,
    unmatched: { baseline: missing(baseline, candidate), candidate: missing(candidate, baseline) },
    regressions: comparisons.flatMap((c) => METRICS.filter((m) => c.metrics[m].regression)
      .map((metric) => ({ key: c.key, metric, deltaSeconds: c.metrics[metric].deltaSeconds,
        deltaPercent: c.metrics[metric].deltaPercent }))),
  };
}

export function markdown(report) {
  const lines = [
    "# Latency comparison (report only)", "",
    `Data classification: **${report.kind}**. No actual browser timings were collected by this command.`,
    `Thresholds: >${round(report.thresholds.relativeThreshold * 100)}% AND >${report.thresholds.absoluteThresholdSeconds}s; minimum ${report.thresholds.minSamples} samples per arm.`,
    "Cold (fresh) and retained turns are never pooled. Missing measurements are unavailable, not zero.", "",
    "| Stage / case / model / turn / width | Metric | Baseline median (n) | Candidate median (n) | Delta | Assessment |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const entry of report.comparisons) {
    const k = entry.key;
    const label = [k.stage, k.case, k.model, k.turn, `w${k.width}`].join(" / ");
    for (const m of report.metrics) {
      const x = entry.metrics[m];
      const show = (v) => v ? `${v.median}s (${v.n})` : "—";
      lines.push(`| ${label} | ${m} | ${show(x.baseline)} | ${show(x.candidate)} | ${x.deltaSeconds === undefined ? "—" : `${x.deltaSeconds}s`} | ${x.status === "compared" ? x.regression ? "REGRESSION" : "no regression flagged" : x.status} |`);
    }
  }
  lines.push("", `Regressions flagged: **${report.regressions.length}** (informational; exit status remains 0).`,
    `Unmatched baseline groups: ${report.unmatched.baseline.length}; unmatched candidate groups: ${report.unmatched.candidate.length}.`,
    "", "These are client-side ACP measurements, not network/model-internal timings. First answer chunk is not necessarily the first model token. Queue wait and tool durations are included only when measured per turn. p95 is suppressed below 20 samples. Compare like-for-like hosts, workload, memory pressure, concurrency, and cold/warm state.");
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) throw new Error("expected --name value pairs");
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  if (!flags.baseline || !flags.candidate || !flags.output) {
    throw new Error("usage: node scripts/latency-regression.mjs --baseline rows.json --candidate rows.json --output report.json [--markdown report.md] [--kind synthetic-fixture|live-acp] [--relative 0.2] [--absolute-seconds 0.5] [--min-samples 3]");
  }
  if (flags.kind && !["synthetic-fixture", "live-acp"].includes(flags.kind)) throw new Error("invalid kind");
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const read = (file) => JSON.parse(readFileSync(file, "utf8"));
    const report = analyze(read(args.baseline), read(args.candidate), {
      relativeThreshold: args.relative === undefined ? undefined : Number(args.relative),
      absoluteThresholdSeconds: args["absolute-seconds"] === undefined ? undefined : Number(args["absolute-seconds"]),
      minSamples: args["min-samples"] === undefined ? undefined : Number(args["min-samples"]),
    });
    report.kind = args.kind ?? "synthetic-fixture";
    writeFileSync(args.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    if (args.markdown) writeFileSync(args.markdown, markdown(report), { mode: 0o600 });
    process.stdout.write(`Compared ${report.comparisons.length} groups; ${report.regressions.length} informational regressions; output ${args.output}\n`);
  } catch (error) {
    process.stderr.write(`latency-regression: ${error.message}\n`);
    process.exitCode = 2;
  }
}
