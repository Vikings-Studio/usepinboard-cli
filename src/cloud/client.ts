import { PROTOCOL_VERSION } from "../constants.js";
import { PROTOCOL_VERSION_HEADER } from "../protocol/version.js";
import { sanitizeUntrustedText, truncateUtf8 } from "../security/untrusted.js";
import { isCloudIdentifier } from "./identifiers.js";

export interface SpikeBootstrap {
  organizationId: string;
  userId: string;
  deviceId: string;
  repositoryIds: string[];
  protocolVersion: number;
}

export class CloudClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;

  constructor(message: string, code: string, status: number, requestId: string | null) {
    const safe = (value: string, bytes: number): string => truncateUtf8(sanitizeUntrustedText(value).replace(/\s+/gu, " ").trim(), bytes);
    super(safe(message, 2048));
    this.name = "CloudClientError";
    this.code = safe(code, 128);
    this.status = status;
    this.requestId = requestId ? safe(requestId, 256) : null;
  }
}

export function normalizeCloudApiUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The relay URL must use HTTPS except for loopback testing");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The relay URL cannot contain credentials, a query, or a fragment");
  return url.toString().replace(/\/+$/u, "");
}

export class SpikeClient {
  readonly apiUrl: string;
  readonly token: string;

  constructor(apiUrl: string, token: string) {
    this.apiUrl = normalizeCloudApiUrl(apiUrl);
    this.token = token;
  }

  async bootstrap(): Promise<SpikeBootstrap> {
    const value = await this.call<unknown>("GET", "/v1/spike/bootstrap");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay bootstrap response is incompatible with this CLI");
    const data = (value as { data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Relay bootstrap response is incompatible with this CLI");
    const bootstrap = data as Partial<SpikeBootstrap>;
    if (bootstrap.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(bootstrap.repositoryIds)
      || !bootstrap.repositoryIds.every(isCloudIdentifier)
      || !isCloudIdentifier(bootstrap.organizationId) || !isCloudIdentifier(bootstrap.userId) || !isCloudIdentifier(bootstrap.deviceId)) {
      throw new Error("Relay bootstrap response is incompatible with this CLI");
    }
    return bootstrap as SpikeBootstrap;
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.call<T>("POST", path, body, idempotencyKey);
  }

  async patch<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.call<T>("PATCH", path, body, idempotencyKey);
  }

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!/^\/(?!\/)/u.test(path)) throw new Error("Relay paths must begin with exactly one slash");
    if (method !== "GET" && (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey))) {
      throw new Error("Relay mutations require an 8-128 character safe idempotency key");
    }
    const endpoint = new URL(path, `${this.apiUrl}/`);
    if (endpoint.origin !== new URL(this.apiUrl).origin) throw new Error("Relay request escaped the configured origin");
    const response = await fetch(endpoint, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const requestId = response.headers.get("x-request-id");
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 2 * 1024 * 1024) {
      throw new CloudClientError("Relay response exceeds 2 MiB", "INVALID_RESPONSE", response.status, requestId);
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new CloudClientError("Relay response exceeds 2 MiB", "INVALID_RESPONSE", response.status, requestId);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new CloudClientError("Relay returned invalid JSON", "INVALID_RESPONSE", response.status, requestId);
    }
    if (!response.ok) {
      const failure = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as { error?: { code?: unknown; message?: unknown; requestId?: unknown } }
        : {};
      throw new CloudClientError(
        typeof failure.error?.message === "string" ? failure.error.message : "Relay request failed",
        typeof failure.error?.code === "string" ? failure.error.code : "RELAY_ERROR",
        response.status,
        requestId,
      );
    }
    return parsed as T;
  }
}
