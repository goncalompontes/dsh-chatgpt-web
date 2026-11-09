import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Codex CLI's public OAuth client. The access token produced by `codex login` is scoped to the
 * user's ChatGPT subscription; the Codex backend requires the same caller identity. This is a
 * public client id, not a secret.
 */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_RESPONSES_ORIGINATOR = "codex_cli_rs";
export const CODEX_CLIENT_COMPAT_VERSION = "0.144.0";

const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

export interface CodexAuthTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
}

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexAuthTokens;
  last_refresh?: string;
}

export interface CodexCredential {
  accessToken: string;
  accountId?: string;
  refreshToken?: string;
  /** Unix epoch milliseconds, decoded from the access token JWT. */
  expiresAt?: number;
  sourcePath: string;
}

export type CodexFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class NativeCodexUnavailableError extends Error {
  readonly code: string;

  constructor(message: string, options: { code: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NativeCodexUnavailableError";
    this.code = options.code;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Default Codex credential path, honoring CODEX_HOME like the official CLI. */
export function defaultCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return join(home && home.length > 0 ? home : join(homedir(), ".codex"), "auth.json");
}

export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return asObject(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) return undefined;
  const auth = asObject(claims["https://api.openai.com/auth"]);
  return asString(auth?.chatgpt_account_id)
    ?? asString(claims.chatgpt_account_id)
    ?? asString(claims.account_id);
}

function expiryFromClaims(claims: Record<string, unknown> | undefined): number | undefined {
  const exp = claims?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

export function credentialFromAuthFile(
  auth: CodexAuthFile,
  sourcePath: string,
): CodexCredential | undefined {
  const tokens = asObject(auth.tokens);
  const accessToken = asString(tokens?.access_token);
  if (!accessToken) return undefined;
  const claims = decodeJwtClaims(accessToken);
  return {
    accessToken,
    ...(asString(tokens?.account_id) ?? accountIdFromClaims(claims)
      ? { accountId: asString(tokens?.account_id) ?? accountIdFromClaims(claims)! }
      : {}),
    ...(asString(tokens?.refresh_token) ? { refreshToken: asString(tokens?.refresh_token)! } : {}),
    ...(expiryFromClaims(claims) !== undefined ? { expiresAt: expiryFromClaims(claims)! } : {}),
    sourcePath,
  };
}

export function readCodexAuthFile(path: string): CodexAuthFile {
  if (!existsSync(path)) {
    throw new NativeCodexUnavailableError(
      `Codex credentials are missing at ${path}; run "codex login" or set nativeCodex.authPath`,
      { code: "native_codex_auth_missing" },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new NativeCodexUnavailableError(
      `Codex credentials at ${path} are not valid JSON`,
      { code: "native_codex_auth_invalid", cause: error },
    );
  }
  const auth = asObject(parsed);
  if (!auth) {
    throw new NativeCodexUnavailableError(
      `Codex credentials at ${path} are not an object`,
      { code: "native_codex_auth_invalid" },
    );
  }
  return auth as CodexAuthFile;
}

export function credentialNeedsRefresh(
  credential: CodexCredential,
  now = Date.now(),
  skewMs = DEFAULT_REFRESH_SKEW_MS,
): boolean {
  return credential.expiresAt !== undefined && credential.expiresAt - now <= skewMs;
}

function atomicWritePrivateFile(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  try {
    // The file contains a password-equivalent refresh token.
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch {
    // Platform ACLs may manage the mode; the write already succeeded.
  }
}

interface RefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

/**
 * Refresh an expired Codex access token and persist the rotated tokens to the same auth file.
 * Refresh tokens are single-use, so the write-back is not optional.
 */
export async function refreshCodexCredential(options: {
  auth: CodexAuthFile;
  authPath: string;
  fetchImpl?: CodexFetch;
  now?: number;
}): Promise<CodexCredential> {
  const refreshToken = asString(asObject(options.auth.tokens)?.refresh_token);
  if (!refreshToken) {
    throw new NativeCodexUnavailableError(
      "Codex credentials have no refresh token; run codex login",
      { code: "native_codex_refresh_missing" },
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    client_id: CODEX_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  let response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
  }).catch(error => {
    throw new NativeCodexUnavailableError(
      "Codex token refresh request failed",
      { code: "native_codex_refresh_failed", cause: error },
    );
  });
  if (!response.ok && (response.status === 400 || response.status === 415)) {
    // Some OAuth deployments require form encoding. Retry once with the same single-use token.
    response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    }).catch(error => {
      throw new NativeCodexUnavailableError(
        "Codex token refresh request failed",
        { code: "native_codex_refresh_failed", cause: error },
      );
    });
  }
  if (!response.ok) {
    throw new NativeCodexUnavailableError(
      `Codex token refresh was rejected with HTTP ${response.status}; run codex login again`,
      { code: "native_codex_refresh_rejected" },
    );
  }
  let payload: RefreshResponse;
  try {
    payload = await response.json() as RefreshResponse;
  } catch (error) {
    throw new NativeCodexUnavailableError(
      "Codex token refresh returned an invalid response",
      { code: "native_codex_refresh_invalid", cause: error },
    );
  }
  const accessToken = asString(payload.access_token);
  if (!accessToken) {
    throw new NativeCodexUnavailableError(
      "Codex token refresh returned no access token",
      { code: "native_codex_refresh_invalid" },
    );
  }
  const claims = decodeJwtClaims(accessToken);
  const nextRefresh = asString(payload.refresh_token) ?? refreshToken;
  const next: CodexAuthFile = {
    ...options.auth,
    tokens: {
      ...asObject(options.auth.tokens),
      access_token: accessToken,
      refresh_token: nextRefresh,
      ...(asString(payload.id_token) ? { id_token: asString(payload.id_token)! } : {}),
      ...(accountIdFromClaims(claims) ? { account_id: accountIdFromClaims(claims)! } : {}),
    },
    last_refresh: new Date(options.now ?? Date.now()).toISOString(),
  };
  atomicWritePrivateFile(options.authPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    accessToken,
    ...(accountIdFromClaims(claims) ? { accountId: accountIdFromClaims(claims)! } : {}),
    refreshToken: nextRefresh,
    ...(expiryFromClaims(claims) !== undefined ? { expiresAt: expiryFromClaims(claims)! } : {}),
    sourcePath: options.authPath,
  };
}

/**
 * Load a usable Codex credential, refreshing it when it is close to expiry. Throws a typed
 * `NativeCodexUnavailableError` when the native route cannot authenticate; the server can then
 * fall back to the browser instead of returning an opaque upstream error.
 */
export async function loadNativeCodexCredential(options: {
  authPath: string;
  fetchImpl?: CodexFetch;
  now?: number;
  refreshSkewMs?: number;
}): Promise<CodexCredential> {
  const auth = readCodexAuthFile(options.authPath);
  if (auth.auth_mode !== "chatgpt") {
    throw new NativeCodexUnavailableError(
      `Codex auth mode is ${JSON.stringify(auth.auth_mode ?? "missing")}; the native route requires ChatGPT login`,
      { code: "native_codex_auth_mode" },
    );
  }
  const credential = credentialFromAuthFile(auth, options.authPath);
  if (!credential) {
    throw new NativeCodexUnavailableError(
      "Codex credentials contain no access token; run codex login",
      { code: "native_codex_token_missing" },
    );
  }
  const now = options.now ?? Date.now();
  if (!credentialNeedsRefresh(credential, now, options.refreshSkewMs)) return credential;
  try {
    return await refreshCodexCredential({
      auth,
      authPath: options.authPath,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      now,
    });
  } catch (error) {
    // A still-valid token is better than failing the native route just because refresh is down.
    if (credential.expiresAt !== undefined && credential.expiresAt > now) return credential;
    throw error;
  }
}

/** Headers the Codex backend expects for subscription-authenticated Responses traffic. */
export function nativeCodexHeaders(credential: CodexCredential, source?: Headers): Headers {
  const headers = new Headers(source);
  headers.set("authorization", `Bearer ${credential.accessToken}`);
  if (credential.accountId) headers.set("chatgpt-account-id", credential.accountId);
  headers.set("originator", CODEX_RESPONSES_ORIGINATOR);
  const currentUserAgent = headers.get("user-agent") ?? "";
  if (!/^codex_cli_rs\//i.test(currentUserAgent)) {
    headers.set("user-agent", `${CODEX_RESPONSES_ORIGINATOR}/${CODEX_CLIENT_COMPAT_VERSION}`);
  }
  // DSH session routing headers are local metadata; do not leak them upstream.
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("x-dsh-")) headers.delete(name);
  }
  return headers;
}
