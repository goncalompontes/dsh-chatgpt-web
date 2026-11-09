import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import {
  NativeCodexUnavailableError,
  credentialFromAuthFile,
  credentialNeedsRefresh,
  decodeJwtClaims,
  loadNativeCodexCredential,
  nativeCodexHeaders,
} from "../src/native-codex-auth";
import {
  DEFAULT_NATIVE_CODEX_FALLBACK_MODEL,
  isNativeCodexModel,
  nativeCodexBrowserFallback,
  resolveNativeCodexConfig,
} from "../src/native-codex-route";
import { modelsRequest, responseRequest } from "../src/server";

function jwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

function authFile(claims: Record<string, unknown>, refreshToken = "refresh-1") {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt(claims),
      refresh_token: refreshToken,
      account_id: "acct-1",
    },
  };
}

function tempAuth(value: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-native-codex-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return { dir, path };
}

test("decodes token expiry and account identity", () => {
  const credential = credentialFromAuthFile(authFile({
    exp: 2_000_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-claims" },
  }), "/tmp/auth.json");
  expect(credential?.accessToken.startsWith("x.")).toBe(true);
  expect(credential?.accountId).toBe("acct-1");
  expect(credential?.expiresAt).toBe(2_000_000_000_000);
  expect(credentialNeedsRefresh(credential!, 1_999_999_900_000)).toBe(true);
  expect(credentialNeedsRefresh(credential!, 1_999_999_000_000)).toBe(false);
  expect(credentialNeedsRefresh(credential!, 1_900_000_000_000)).toBe(false);
});

test("rejects missing, invalid, and non-ChatGPT auth files with typed errors", async () => {
  const missing = await loadNativeCodexCredential({ authPath: "/tmp/definitely-missing-codex-auth.json" })
    .catch(error => error);
  expect(missing).toBeInstanceOf(NativeCodexUnavailableError);
  expect((missing as NativeCodexUnavailableError).code).toBe("native_codex_auth_missing");

  const nonChatGpt = tempAuth({ auth_mode: "apikey", tokens: { access_token: "x" } });
  const modeError = await loadNativeCodexCredential({ authPath: nonChatGpt.path }).catch(error => error);
  expect((modeError as NativeCodexUnavailableError).code).toBe("native_codex_auth_mode");
  rmSync(nonChatGpt.dir, { recursive: true, force: true });
});

test("refreshes an expired token and persists rotated credentials with private mode", async () => {
  const now = 1_800_000_000_000;
  const { dir, path } = tempAuth(authFile({ exp: Math.floor(now / 1000) - 10 }, "old-refresh"));
  const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json({
      access_token: jwt({
        exp: Math.floor(now / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" },
      }),
      refresh_token: "new-refresh",
    });
  };
  try {
    const credential = await loadNativeCodexCredential({
      authPath: path,
      fetchImpl,
      now,
      refreshSkewMs: 300_000,
    });
    expect(credential.accessToken).toContain(".");
    expect(credential.accountId).toBe("acct-2");
    expect(credential.refreshToken).toBe("new-refresh");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toContain("auth.openai.com/oauth/token");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.tokens.refresh_token).toBe("new-refresh");
    expect(persisted.tokens.account_id).toBe("acct-2");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a still-valid token when refresh is rejected", async () => {
  const now = 1_800_000_000_000;
  const { dir, path } = tempAuth(authFile({ exp: Math.floor(now / 1000) + 60 }));
  try {
    const credential = await loadNativeCodexCredential({
      authPath: path,
      now,
      refreshSkewMs: 300_000,
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    expect(credential.accessToken).toContain(".");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native headers replace the placeholder bearer and strip DSH-local metadata", () => {
  const headers = nativeCodexHeaders({
    accessToken: "native-token",
    accountId: "acct-1",
    sourcePath: "/tmp/auth.json",
  }, new Headers({
    authorization: "Bearer chatgpt-web-free",
    "x-dsh-session-id": "secret-session",
    "user-agent": "dsh/1.0",
  }));
  expect(headers.get("authorization")).toBe("Bearer native-token");
  expect(headers.get("chatgpt-account-id")).toBe("acct-1");
  expect(headers.get("originator")).toBe("codex_cli_rs");
  expect(headers.get("user-agent")).toContain("codex_cli_rs/");
  expect(headers.get("x-dsh-session-id")).toBeNull();
});

test("native route config is opt-in and maps browser fallbacks", () => {
  const disabled = resolveNativeCodexConfig({ nativeCodex: undefined }, {});
  expect(disabled.enabled).toBe(false);
  expect(isNativeCodexModel("gpt-6.1-sol", disabled)).toBe(false);

  const enabled = resolveNativeCodexConfig({
    nativeCodex: {
      enabled: true,
      authPath: "/tmp/auth.json",
      models: ["gpt-6.1-sol"],
      browserFallback: true,
      fallbackModel: "chatgpt-web/high",
    },
  }, {});
  expect(enabled.enabled).toBe(true);
  expect(isNativeCodexModel("gpt-6.1-sol", enabled)).toBe(true);
  expect(isNativeCodexModel("chatgpt-web/high", enabled)).toBe(false);
  expect(nativeCodexBrowserFallback("gpt-6.1-sol", enabled)).toBe("chatgpt-web/high");
  const automaticFallback = { ...enabled, fallbackModel: "" };
  expect(nativeCodexBrowserFallback("gpt-6.1-sol", automaticFallback)).toBe("chatgpt-web/gpt-6-high");
  expect(nativeCodexBrowserFallback("gpt-5.6-luna", automaticFallback)).toBe("chatgpt-web/luna");
  expect(nativeCodexBrowserFallback("unknown", automaticFallback)).toBe("chatgpt-web/high");
  expect(enabled.fallbackModel).toBe("chatgpt-web/high");
  expect(DEFAULT_NATIVE_CODEX_FALLBACK_MODEL).toBe("chatgpt-web/high");
});

test("DSH model discovery advertises native models and keeps browser fallback", async () => {
  const config = {
    ...defaultConfig(),
    purpose: "dsh" as const,
    nativeCodex: {
      enabled: true,
      authPath: "/tmp/auth.json",
      models: ["gpt-6.1-sol", "gpt-6-luna"],
      browserFallback: true,
    },
  };
  const response = await modelsRequest(new Request("http://127.0.0.1/v1/models"), config);
  const body = await response.json() as { data: Array<{ id: string; owned_by: string }> };
  expect(body.data.some(model => model.id === "gpt-6.1-sol" && model.owned_by === "codex-native")).toBe(true);
  expect(body.data.some(model => model.id === "chatgpt-web/high")).toBe(true);
});

test("native Responses calls use the Codex credential instead of the placeholder bearer", async () => {
  const now = Date.now();
  const { dir, path } = tempAuth(authFile({ exp: Math.floor(now / 1000) + 3600 }));
  const config = {
    ...defaultConfig(),
    purpose: "dsh" as const,
    nativeCodex: {
      enabled: true,
      authPath: path,
      models: ["gpt-6.1-sol"],
      browserFallback: true,
    },
  };
  let captured: Request | undefined;
  const nativeFetch = async (request: Request) => {
    captured = request;
    return new Response('event: delta_encoding\ndata: "v1"\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer chatgpt-web-free",
        "x-dsh-session-id": "dsh-session",
      },
      body: JSON.stringify({
        model: "gpt-6.1-sol",
        stream: true,
        input: [{ role: "user", content: "hi" }],
      }),
    }), config, () => { throw new Error("browser adapter must not run"); }, { nativeFetch, rememberState: false });
    expect(response.status).toBe(200);
    expect(captured?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer " + JSON.parse(readFileSync(path, "utf8")).tokens.access_token);
    expect(captured?.headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(captured?.headers.get("originator")).toBe("codex_cli_rs");
    expect(captured?.headers.get("x-dsh-session-id")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native auth failure falls back to the browser route", async () => {
  const config = {
    ...defaultConfig(),
    purpose: "dsh" as const,
    nativeCodex: {
      enabled: true,
      authPath: "/tmp/missing-native-auth.json",
      models: ["gpt-6.1-sol"],
      browserFallback: true,
      fallbackModel: "chatgpt-web/high",
    },
  };
  let capturedModel: string | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6.1-sol",
      stream: false,
      input: [{ role: "user", content: "hi" }],
    }),
  }), config, () => ({
    name: "fallback",
    async runTurn(parsed, _incoming, emit) {
      capturedModel = parsed.modelId;
      emit({ type: "text_delta", text: "browser fallback" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
  expect(response.status).toBe(200);
  expect(capturedModel).toBe("gpt-5.6-sol");
  const body = await response.json() as { output: Array<{ type: string; content?: Array<{ text?: string }> }> };
  expect(JSON.stringify(body)).toContain("browser fallback");
});
