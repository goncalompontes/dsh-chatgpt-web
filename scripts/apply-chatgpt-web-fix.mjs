#!/usr/bin/env node
/**
 * Apply a verified ChatGPT-Web fix to main and, when it is safe, to the running sidecar.
 *
 * A fix thread owns one branch in its own worktree. This script is the only thing allowed to move
 * that work into production:
 *
 *   1. take an exclusive lock (one apply at a time),
 *   2. merge the branch onto current `fork/main` in a throwaway build worktree,
 *   3. prove the merged tree with `bun run typecheck` and `bun test`,
 *   4. push it to `main`,
 *   5. update the dedicated deployment worktree (a clean checkout the stack runs from) and rebuild
 *      its bundle,
 *   6. restart the sidecar through the stack supervisor only when it has no active or queued turn,
 *      then wait for health.
 *
 * There is no code hot reload in the sidecar (only config hot reload), so "reload" means an idle
 * restart. A busy host defers the restart instead of breaking work. Deployment never touches the
 * developer checkout, so uncommitted work there is never overwritten.
 *
 * Usage:
 *   node apply-chatgpt-web-fix.mjs --branch <ref> [--no-deploy] [--repo <path>]
 *
 * Env overrides: APPLY_REPO (git repo used for merging), APPLY_BUILD_DIR (throwaway build
 * worktree), APPLY_APP_DIR (deployment worktree the stack sidecar runs from), APPLY_REMOTE,
 * APPLY_HEALTH, APPLY_STACK, APPLY_IDLE_TIMEOUT_SECONDS, APPLY_BUN.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const args = parseArgs(process.argv.slice(2));
const REPO = args.repo ?? process.env.APPLY_REPO ?? join(HOME, "projects/dsh-chatgpt-web");
const CONFIG = {
  repo: REPO,
  buildDir: process.env.APPLY_BUILD_DIR ?? join(HOME, ".dsh/storages/chatgpt-web/deploy-build"),
  appDir: process.env.APPLY_APP_DIR ?? join(HOME, ".local/share/dsh-web-stack/app"),
  remote: process.env.APPLY_REMOTE ?? "fork",
  healthUrl: process.env.APPLY_HEALTH ?? "http://127.0.0.1:17841/healthz",
  stack: process.env.APPLY_STACK ?? "dsh-web-stack",
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

/** Ensure `dir` is a worktree of the repository, creating it detached at `ref` when missing. */
function ensureWorktree(dir, ref) {
  mkdirSync(dir, { recursive: true });
  const registered = git(CONFIG.repo, "worktree", "list", "--porcelain").includes(`worktree ${dir}`);
  if (!registered && existsSync(join(dir, ".git"))) {
    throw new Error(`Directory exists but is not a worktree of ${CONFIG.repo}: ${dir}`);
  }
  if (!registered) git(CONFIG.repo, "worktree", "add", "--detach", dir, ref);
  return registered;
}

function prepareBuildWorktree(branch) {
  ensureWorktree(CONFIG.buildDir, `${CONFIG.remote}/main`);
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

/**
 * Move the deployment worktree to the merged commit and rebuild its bundle. This tree is what the
 * stack launches, so it is kept clean and never shares a checkout with developer edits.
 */
function prepareDeployApp(head) {
  ensureWorktree(CONFIG.appDir, head);
  git(CONFIG.appDir, "fetch", CONFIG.remote, "--prune");
  git(CONFIG.appDir, "checkout", "--detach", "--force", head);
  git(CONFIG.appDir, "reset", "--hard", head);
  git(CONFIG.appDir, "clean", "-fd", "-e", "node_modules");
  if (!existsSync(join(CONFIG.appDir, "node_modules"))) {
    log("installing dependencies in the deployment worktree");
    run(CONFIG.appDir, CONFIG.bun, ["install", "--prefer-offline"]);
  }
  log("building the deployment bundle");
  run(CONFIG.appDir, CONFIG.bun, ["run", "build"]);
  if (!existsSync(join(CONFIG.appDir, "lib", "cli.js"))) {
    throw new Error(`Build did not produce ${join(CONFIG.appDir, "lib", "cli.js")}`);
  }
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
  try {
    prepareBuildWorktree(args.branch);
    verify();
    mergedHead = git(CONFIG.buildDir, "rev-parse", "HEAD");
    log(`pushing ${mergedHead} to ${CONFIG.remote} main`);
    git(CONFIG.buildDir, "push", CONFIG.remote, `HEAD:main`);
  } catch (error) {
    release();
    result({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      branch: args.branch,
      merged: false,
    }, 1);
  }

  const summary = { ok: true, branch: args.branch, merged: true, head: mergedHead, pushed: true };
  if (args.deploy === false) {
    release();
    result({ ...summary, deployed: false, built: false, reason: "--no-deploy" });
  }

  try {
    prepareDeployApp(mergedHead);
  } catch (error) {
    release();
    result({
      ...summary, deployed: false, built: false,
      error: error instanceof Error ? error.message : String(error),
      reason: "merged into main, but the deployment worktree could not be updated; the running sidecar is untouched",
    }, 1);
  }

  const status = await waitForIdle(CONFIG.idleTimeoutSeconds * 1_000);
  if (!status) {
    release();
    result({
      ...summary, deployed: false, built: true,
      reason: `sidecar stayed busy for ${CONFIG.idleTimeoutSeconds}s; merged, pushed and built into the deployment worktree, restart deferred`,
    });
  }
  try {
    const next = await deploy(status);
    release();
    result({
      ...summary, deployed: true, built: true,
      sidecar: { previousPid: status.pid, pid: next.pid, healthz: CONFIG.healthUrl, appDir: CONFIG.appDir },
    });
  } catch (error) {
    release();
    result({
      ...summary, deployed: false, built: true,
      error: error instanceof Error ? error.message : String(error),
      reason: "merged into main and built into the deployment worktree, but the restart failed; inspect the sidecar log",
    }, 1);
  }
}

main().catch(error => {
  console.error(`[apply] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
