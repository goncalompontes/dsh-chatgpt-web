#!/usr/bin/env node
/**
 * Apply a verified ChatGPT-Web fix to main and, when it is safe, to the running sidecar.
 *
 * A fix thread owns one branch in its own worktree. This script is the only thing allowed to move
 * that work into production:
 *
 *   1. take an exclusive lock (one apply at a time),
 *   2. build the integration tree in a dedicated worktree: current `fork/main` + the fix branch,
 *   3. prove it with `bun run typecheck` and `bun test` on that merged tree,
 *   4. push it to `main` (fast-forward or merge commit),
 *   5. rebuild `lib/` from the merged source,
 *   6. deploy only when the sidecar has no active or queued turn and the deployment checkout has no
 *      uncommitted source changes: copy the bundle, restart the sidecar through the stack
 *      supervisor, and wait for health.
 *
 * There is no code hot reload in the sidecar (only config hot reload), so "reload" means an idle
 * restart. A busy host or a dirty source checkout defers the deploy instead of breaking work.
 *
 * Usage:
 *   node apply-chatgpt-web-fix.mjs --branch <ref> [--no-deploy] [--repo <path>]
 *
 * Env overrides: APPLY_REPO, APPLY_BUILD_DIR, APPLY_REMOTE, APPLY_HEALTH, APPLY_STACK,
 *                APPLY_DEPLOY_LIB (default <repo>/lib), APPLY_IDLE_TIMEOUT_SECONDS.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  repo: args.repo ?? process.env.APPLY_REPO ?? join(HOME, "projects/dsh-chatgpt-web"),
  buildDir: process.env.APPLY_BUILD_DIR ?? join(HOME, ".dsh/storages/chatgpt-web/deploy-build"),
  remote: process.env.APPLY_REMOTE ?? "fork",
  healthUrl: process.env.APPLY_HEALTH ?? "http://127.0.0.1:17841/healthz",
  stack: process.env.APPLY_STACK ?? "dsh-web-stack",
  deployLib: process.env.APPLY_DEPLOY_LIB ?? join(args.repo ?? process.env.APPLY_REPO ?? join(HOME, "projects/dsh-chatgpt-web"), "lib"),
  idleTimeoutSeconds: Number(process.env.APPLY_IDLE_TIMEOUT_SECONDS ?? 120),
  bun: process.env.APPLY_BUN ?? "bun",
};
const LOCK_PATH = join(HOME, ".dsh/storages/chatgpt-web/apply.lock");

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-deploy") parsed.deploy = false;
    else if (arg === "--branch") parsed.branch = argv[++i];
    else if (arg === "--repo") parsed.repo = argv[++i];
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function log(message) {
  process.stdout.write(`[apply ${new Date().toISOString()}] ${message}\n`);
}

function result(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 1)}\n`);
  process.exit(code);
}

function git(cwd, ...argv) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function run(cwd, command, argv, timeout = 900_000) {
  execFileSync(command, argv, { cwd, stdio: "inherit", timeout });
}

function acquireLock() {
  mkdirSync(join(HOME, ".dsh/storages/chatgpt-web"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(LOCK_PATH, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
      if (age < 2 * 3_600_000) return undefined;
      rmSync(LOCK_PATH, { force: true });
    }
  }
  return undefined;
}

function prepareBuildWorktree(branch) {
  mkdirSync(CONFIG.buildDir, { recursive: true });
  const registered = git(CONFIG.repo, "worktree", "list", "--porcelain").includes(`worktree ${CONFIG.buildDir}`);
  if (!registered && existsSync(join(CONFIG.buildDir, ".git"))) {
    throw new Error(`Build directory exists but is not a worktree of ${CONFIG.repo}: ${CONFIG.buildDir}`);
  }
  if (!registered) {
    git(CONFIG.repo, "worktree", "add", "--detach", CONFIG.buildDir, `${CONFIG.remote}/main`);
  }
  git(CONFIG.buildDir, "fetch", CONFIG.remote, "--prune");
  git(CONFIG.buildDir, "checkout", "--detach", "--force", `${CONFIG.remote}/main`);
  git(CONFIG.buildDir, "reset", "--hard", `${CONFIG.remote}/main`);
  git(CONFIG.buildDir, "clean", "-fd", "-e", "node_modules");
  if (!existsSync(join(CONFIG.buildDir, "node_modules"))) {
    log("installing dependencies in the build worktree");
    run(CONFIG.buildDir, CONFIG.bun, ["install", "--prefer-offline"]);
  }
  log(`merging ${branch} into ${CONFIG.remote}/main`);
  run(CONFIG.buildDir, "git", ["merge", "--no-ff", "--no-edit", branch]);
}

function verify() {
  log("typecheck");
  run(CONFIG.buildDir, CONFIG.bun, ["run", "typecheck"]);
  log("tests");
  run(CONFIG.buildDir, CONFIG.bun, ["test"]);
}

async function health() {
  try {
    const response = await fetch(CONFIG.healthUrl, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function idle(status) {
  if (!status) return false;
  const admission = status.browser_admission ?? {};
  return (status.active_http_turns ?? 0) === 0
    && (status.active_browser_turns ?? 0) === 0
    && (admission.active ?? 0) === 0
    && (admission.pending ?? 0) === 0;
}

async function waitForIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await health();
    if (status && idle(status)) return status;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}

function deployCheckoutIsClean() {
  // Only source inputs must be clean; lib/ is the build output this script owns.
  const dirty = git(CONFIG.repo, "status", "--porcelain", "--", "src", "package.json", "bun.lock", "tsconfig.json");
  return dirty.length === 0;
}

function installBundle() {
  mkdirSync(CONFIG.deployLib, { recursive: true });
  for (const file of ["cli.js", "plugin.js"]) {
    const source = join(CONFIG.buildDir, "lib", file);
    const target = join(CONFIG.deployLib, file);
    if (!existsSync(source)) throw new Error(`Build did not produce ${source}`);
    const temporary = `${target}.apply-${process.pid}`;
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  }
}

async function deploy(status) {
  log(`restarting sidecar pid=${status.pid}`);
  const before = status.pid;
  process.kill(before, "SIGTERM");
  const downDeadline = Date.now() + 20_000;
  while (Date.now() < downDeadline) {
    if (!(await health())) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  log("asking the stack supervisor to start the sidecar");
  run(CONFIG.repo, CONFIG.stack, ["ensure", "--client-pid", String(process.pid)], 120_000);
  const upDeadline = Date.now() + 60_000;
  while (Date.now() < upDeadline) {
    const next = await health();
    if (next && next.pid !== before) return next;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`sidecar did not become healthy again after restart (previous pid ${before})`);
}

async function main() {
  if (args.help) {
    console.log("Usage: apply-chatgpt-web-fix.mjs --branch <ref> [--no-deploy] [--repo <path>]");
    return;
  }
  if (!args.branch) result({ ok: false, error: "--branch is required" }, 1);
  if (!existsSync(CONFIG.repo)) result({ ok: false, error: `repo not found: ${CONFIG.repo}` }, 1);

  const release = acquireLock();
  if (!release) result({ ok: false, error: "another apply is running" }, 1);
  let mergedHead;
  let buildReady = false;
  try {
    prepareBuildWorktree(args.branch);
    verify();
    mergedHead = git(CONFIG.buildDir, "rev-parse", "HEAD");
    log(`pushing ${mergedHead} to ${CONFIG.remote} main`);
    git(CONFIG.buildDir, "push", CONFIG.remote, `HEAD:main`);
    log("building bundle");
    run(CONFIG.buildDir, CONFIG.bun, ["run", "build"]);
    buildReady = true;
  } catch (error) {
    release();
    result({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      branch: args.branch,
      merged: false,
    }, 1);
  }

  const summary = { ok: true, branch: args.branch, merged: true, head: mergedHead, pushed: true, built: buildReady };
  if (args.deploy === false) {
    release();
    result({ ...summary, deployed: false, reason: "--no-deploy" });
  }
  if (!deployCheckoutIsClean()) {
    release();
    result({
      ...summary, deployed: false,
      reason: `deployment checkout has uncommitted source changes in ${CONFIG.repo}; merged, pushed and built, restart deferred`,
    });
  }
  const status = await waitForIdle(CONFIG.idleTimeoutSeconds * 1_000);
  if (!status) {
    release();
    result({
      ...summary, deployed: false,
      reason: `sidecar stayed busy for ${CONFIG.idleTimeoutSeconds}s; merged, pushed and built, restart deferred`,
    });
  }
  try {
    installBundle();
    const next = await deploy(status);
    release();
    result({ ...summary, deployed: true, sidecar: { previousPid: status.pid, pid: next.pid, healthz: CONFIG.healthUrl } });
  } catch (error) {
    release();
    result({
      ...summary, deployed: false,
      error: error instanceof Error ? error.message : String(error),
      reason: `merged into main, but the restart failed after the bundle was copied; inspect the sidecar log`,
    }, 1);
  }
}

main().catch(error => {
  console.error(`[apply] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
