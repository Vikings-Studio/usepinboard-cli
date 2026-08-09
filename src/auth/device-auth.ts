import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { DEVICE_AUTH_ACCOUNT, DEVICE_AUTH_SERVICE } from "../constants.js";
import { sanitizeUntrustedText, truncateUtf8 } from "../security/untrusted.js";
import type { CredentialStore } from "./credential-store.js";

// RFC 8628-style device authorization grant client for the Pinboard
// backend. The CLI is a public, unauthenticated client: it starts a
// request, the human approves it in the browser, and the CLI polls once
// to receive a scoped opaque access token. The token is stored in the OS
// credential store and never printed.

export const DEVICE_AUTH_SCOPES = ["device:read", "device:write", "presence:read", "messages:read", "messages:write"] as const;

export interface DeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
  userCodeExpiresIn: number;
  scopes: string[];
}

export interface DeviceAuthToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  organizationId: string;
  userId: string;
  deviceId: string;
}

export class DeviceAuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(message: string, code: string, status: number, retryAfter: number | null = null) {
    const safe = (value: string, bytes: number): string => truncateUtf8(sanitizeUntrustedText(value).replace(/\s+/gu, " ").trim(), bytes);
    super(safe(message, 2048));
    this.name = "DeviceAuthError";
    this.code = safe(code, 128);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function normalizeApiUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The Pinboard API URL must use HTTPS except for loopback testing");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The Pinboard API URL cannot contain credentials, a query, or a fragment");
  return url.toString().replace(/\/+$/u, "");
}

export function resolveVerificationUrl(apiUrl: string, verificationUrl: string): string {
  if (verificationUrl.startsWith("http://") || verificationUrl.startsWith("https://")) return verificationUrl;
  if (!verificationUrl.startsWith("/") || verificationUrl.startsWith("//")) {
    throw new Error("The server returned an invalid verification URL");
  }
  return new URL(verificationUrl, `${apiUrl}/`).toString();
}

export interface DeviceAuthClientOptions {
  apiUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DeviceAuthClient {
  readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: DeviceAuthClientOptions) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async start(input: { deviceId: string; deviceName?: string; platform?: string; scopes?: string[] }): Promise<DeviceAuthStart> {
    const body: Record<string, unknown> = {
      deviceId: input.deviceId,
      ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      scopes: input.scopes?.join(" ") ?? DEVICE_AUTH_SCOPES.join(" "),
    };
    const data = await this.call<DeviceAuthStart>("POST", "/v1/device-auth/start", body);
    if (!data || typeof data.deviceCode !== "string" || typeof data.userCode !== "string"
      || typeof data.verificationUrl !== "string" || typeof data.expiresIn !== "number"
      || typeof data.interval !== "number" || !Array.isArray(data.scopes)) {
      throw new DeviceAuthError("The device authorization start response is incompatible with this CLI", "INVALID_RESPONSE", 200);
    }
    return data;
  }

  async poll(deviceCode: string): Promise<DeviceAuthToken> {
    const data = await this.call<DeviceAuthToken>("POST", "/v1/device-auth/token", { deviceCode });
    if (!data || typeof data.accessToken !== "string" || typeof data.tokenType !== "string"
      || typeof data.expiresIn !== "number" || typeof data.scope !== "string"
      || typeof data.organizationId !== "string" || typeof data.userId !== "string"
      || typeof data.deviceId !== "string") {
      throw new DeviceAuthError("The device authorization token response is incompatible with this CLI", "INVALID_RESPONSE", 200);
    }
    return data;
  }

  private async call<T>(method: string, path: string, body: unknown): Promise<T | null> {
    if (!/^\/(?!\/)/u.test(path)) throw new DeviceAuthError("Device authorization paths must begin with exactly one slash", "INVALID_PATH", 400);
    const endpoint = new URL(path, `${this.apiUrl}/`);
    if (endpoint.origin !== new URL(this.apiUrl).origin) throw new DeviceAuthError("Device authorization request escaped the configured origin", "INVALID_PATH", 400);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch (error) {
      throw new DeviceAuthError(
        `The Pinboard API is unreachable (${error instanceof Error ? error.message : "network error"}). Check the API URL and your connection.`,
        "NETWORK_ERROR",
        0,
      );
    }
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      throw new DeviceAuthError("The Pinboard API returned invalid JSON", "INVALID_RESPONSE", response.status, retryAfter);
    }
    if (!response.ok) {
      const failure = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as { error?: { code?: unknown; message?: unknown } }
        : {};
      throw new DeviceAuthError(
        typeof failure.error?.message === "string" ? failure.error.message : "The Pinboard API request failed",
        typeof failure.error?.code === "string" ? failure.error.code : "API_ERROR",
        response.status,
        retryAfter,
      );
    }
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { data?: unknown }).data
      : undefined;
    return (data ?? null) as T | null;
  }
}

// Upper bound on a single poll sleep so a malicious or misconfigured
// retry-after header cannot stall the CLI indefinitely. The device-code
// expiry (advertised in expiresIn, ≤3600s) still bounds the whole flow.
export const MAX_SLEEP_SECONDS = 600;

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, MAX_SLEEP_SECONDS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), MAX_SLEEP_SECONDS);
  return null;
}

export interface DeviceLoginDependencies {
  client: DeviceAuthClient;
  credentialStore: CredentialStore;
  openBrowser?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onShow?: (verificationUrl: string, userCode: string) => void;
  isCancelled?: () => boolean;
}

export interface DeviceLoginResult {
  accessToken: string;
  organizationId: string;
  userId: string;
  deviceId: string;
  scope: string;
  expiresIn: number;
}

export interface DeviceLoginOptions {
  deviceId: string;
  deviceName?: string;
  platform?: string;
  apiUrl: string;
  credentialStore: CredentialStore;
  openBrowser?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onShow?: (verificationUrl: string, userCode: string) => void;
  isCancelled?: () => boolean;
  fetchImpl?: typeof fetch;
}

export async function runDeviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const client = new DeviceAuthClient({
    apiUrl: options.apiUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const isCancelled = options.isCancelled ?? (() => false);

  const started = await client.start({
    deviceId: options.deviceId,
    ...(options.deviceName ? { deviceName: options.deviceName } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });

  const verificationUrl = resolveVerificationUrl(client.apiUrl, started.verificationUrl);
  if (options.onShow) options.onShow(verificationUrl, started.userCode);
  if (options.openBrowser) {
    // The verification URL and user code were already shown above. A
    // failed browser open must not re-print them (which would emit the
    // code twice and could confuse a human into typing it twice); the
    // human already has the URL to open manually.
    await options.openBrowser(verificationUrl).catch(() => undefined);
  }

  const deadline = now() + started.expiresIn * 1000;
  let intervalMs = Math.max(1, started.interval) * 1000;

  for (;;) {
    if (isCancelled()) throw new DeviceAuthError("Device authorization cancelled", "CANCELLED", 0);
    if (now() >= deadline) throw new DeviceAuthError("The device authorization expired before it was approved; start a new one", "EXPIRED_TOKEN", 0);

    let token: DeviceAuthToken;
    try {
      token = await client.poll(started.deviceCode);
    } catch (error) {
      if (!(error instanceof DeviceAuthError)) throw error;
      if (error.code === "AUTHORIZATION_PENDING") {
        await sleep(intervalMs);
        continue;
      }
      if (error.code === "SLOW_DOWN") {
        const retryAfter = error.retryAfter ?? Math.min(MAX_SLEEP_SECONDS, Math.ceil(intervalMs / 1000) + 5);
        intervalMs = Math.max(intervalMs, Math.min(retryAfter, MAX_SLEEP_SECONDS) * 1000);
        await sleep(intervalMs);
        continue;
      }
      if (error.code === "RATE_LIMITED") {
        const retryAfter = error.retryAfter ?? Math.ceil(intervalMs / 1000);
        await sleep(Math.max(intervalMs, Math.min(retryAfter, MAX_SLEEP_SECONDS) * 1000));
        continue;
      }
      if (error.code === "NETWORK_ERROR") {
        await sleep(intervalMs);
        continue;
      }
      if (error.code === "EXPIRED_TOKEN" || error.code === "ACCESS_DENIED" || error.code === "INVALID_GRANT") throw error;
      throw error;
    }

    await options.credentialStore.save(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT, token.accessToken);
    return {
      accessToken: token.accessToken,
      organizationId: token.organizationId,
      userId: token.userId,
      deviceId: token.deviceId,
      scope: token.scope,
      expiresIn: token.expiresIn,
    };
  }
}

export function generateDeviceId(): string {
  return `cli-${randomUUID()}`;
}

export function currentPlatform(): string {
  return platform();
}
