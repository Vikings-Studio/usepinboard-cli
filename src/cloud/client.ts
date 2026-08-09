import { MAX_TASK_LABEL_BYTES, PROTOCOL_VERSION } from "../constants.js";
import { PROTOCOL_VERSION_HEADER } from "../protocol/version.js";
import { sanitizeUntrustedText, truncateUtf8 } from "../security/untrusted.js";
import { CLOUD_IDENTIFIER_PATTERN, isCloudIdentifier, isCloudResourceId, requireCloudIdentifier } from "./identifiers.js";

export interface RelayBootstrap {
  organizationId: string;
  userId: string;
  deviceId: string;
  repositoryIds: string[];
  protocolVersion: number;
}

/** @deprecated Use RelayBootstrap instead */
export type SpikeBootstrap = RelayBootstrap;

export const DISCOVERY_MAX_PAGES = 20;
export const DISCOVERY_PAGE_SIZE = 100;

export interface RelayDiscoveryQuery {
  repositoryId: string;
  includeIdle: boolean;
  branch?: string;
  provider?: string;
  userFilterId?: string;
  taskLabel?: string;
  limit?: number;
  cursor?: string;
}

export interface RelayDiscoverySession {
  id: string;
  repositoryId: string;
  provider: string;
  providerSessionId: string | null;
  branch: string;
  taskLabel: string | null;
  state: "active" | "idle" | "ended" | "stale";
  lastActiveAt: string;
  userId: string;
  deviceId: string;
}

export interface RelayDiscoveryMeta {
  reasonCode: string | null;
  matched: number | null;
  nextCursor: string | null;
}

export interface RelayDiscoveryResult {
  sessions: RelayDiscoverySession[];
  meta: RelayDiscoveryMeta;
}

function parseDiscoverySession(value: unknown): RelayDiscoverySession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay discovery response is incompatible with this CLI");
  const record = value as Record<string, unknown>;
  if (!isCloudResourceId(record.id) || !isCloudIdentifier(record.repositoryId) || !isCloudIdentifier(record.userId)
    || !isCloudIdentifier(record.deviceId) || typeof record.provider !== "string" || !CLOUD_IDENTIFIER_PATTERN.test(record.provider)
    || (record.providerSessionId !== null && typeof record.providerSessionId !== "string")
    || typeof record.branch !== "string" || record.branch.length < 1 || record.branch.length > 512
    || !["active", "idle", "ended", "stale"].includes(String(record.state))
    || (record.taskLabel !== null && (typeof record.taskLabel !== "string" || record.taskLabel.length > MAX_TASK_LABEL_BYTES * 4))) {
    throw new Error("Relay discovery response is incompatible with this CLI");
  }
  let lastActiveAt: string;
  if (typeof record.lastActiveAt === "string") {
    const parsed = new Date(record.lastActiveAt);
    if (Number.isNaN(parsed.getTime())) throw new Error("Relay discovery response is incompatible with this CLI");
    lastActiveAt = parsed.toISOString();
  } else if (typeof record.lastActiveAt === "number" && Number.isFinite(record.lastActiveAt)) {
    lastActiveAt = new Date(record.lastActiveAt).toISOString();
  } else {
    throw new Error("Relay discovery response is incompatible with this CLI");
  }
  return {
    id: record.id,
    repositoryId: record.repositoryId,
    provider: record.provider,
    providerSessionId: record.providerSessionId,
    branch: record.branch,
    taskLabel: typeof record.taskLabel === "string" ? truncateUtf8(sanitizeUntrustedText(record.taskLabel), MAX_TASK_LABEL_BYTES) : null,
    state: record.state as RelayDiscoverySession["state"],
    lastActiveAt,
    userId: record.userId,
    deviceId: record.deviceId,
  };
}

export function parseDiscoveryResponse(value: unknown): RelayDiscoveryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay discovery response is incompatible with this CLI");
  const envelope = value as { data?: unknown; meta?: unknown };
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)
    || !envelope.meta || typeof envelope.meta !== "object" || Array.isArray(envelope.meta)) {
    throw new Error("Relay discovery response is incompatible with this CLI");
  }
  const sessions = (envelope.data as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) throw new Error("Relay discovery response is incompatible with this CLI");
  const meta = envelope.meta as { reasonCode?: unknown; matched?: unknown; nextCursor?: unknown };
  const reasonCode = meta.reasonCode === null || meta.reasonCode === undefined
    ? null
    : typeof meta.reasonCode === "string"
      ? truncateUtf8(sanitizeUntrustedText(meta.reasonCode).replace(/\s+/gu, " ").trim(), 256)
      : (() => { throw new Error("Relay discovery response is incompatible with this CLI"); })();
  const matched = meta.matched === null || meta.matched === undefined
    ? null
    : typeof meta.matched === "number" && Number.isSafeInteger(meta.matched) && meta.matched >= 0
      ? meta.matched
      : (() => { throw new Error("Relay discovery response is incompatible with this CLI"); })();
  const nextCursor = meta.nextCursor === null || meta.nextCursor === undefined
    ? null
    : typeof meta.nextCursor === "string" && meta.nextCursor.length > 0 && meta.nextCursor.length <= 4096
      ? meta.nextCursor
      : (() => { throw new Error("Relay discovery response is incompatible with this CLI"); })();
  return {
    sessions: sessions.map(parseDiscoverySession),
    meta: { reasonCode, matched, nextCursor },
  };
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

export class RelayClient {
  readonly apiUrl: string;
  readonly token: string;

  constructor(apiUrl: string, token: string) {
    this.apiUrl = normalizeCloudApiUrl(apiUrl);
    this.token = token;
  }

  async bootstrap(): Promise<RelayBootstrap> {
    const value = await this.call<unknown>("GET", "/v1/bootstrap");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay bootstrap response is incompatible with this CLI");
    const data = (value as { data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Relay bootstrap response is incompatible with this CLI");
    const bootstrap = data as Partial<RelayBootstrap>;
    if (bootstrap.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(bootstrap.repositoryIds)
      || !bootstrap.repositoryIds.every(isCloudIdentifier)
      || !isCloudIdentifier(bootstrap.organizationId) || !isCloudIdentifier(bootstrap.userId) || !isCloudIdentifier(bootstrap.deviceId)) {
      throw new Error("Relay bootstrap response is incompatible with this CLI");
    }
    return bootstrap as RelayBootstrap;
  }

  async linkRepository(repositoryId: string, repositoryIdentity: string, repositoryName: string): Promise<void> {
    requireCloudIdentifier(repositoryId, "repositoryId");
    await this.call<unknown>("POST", "/v1/repositories/link", { repositoryId, repositoryIdentity, repositoryName }, repositoryId);
  }

  async listRepositories(): Promise<Array<{ id: string; identity: string; name: string }>> {
    const value = await this.call<unknown>("GET", "/v1/repositories");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay repository list response is incompatible with this CLI");
    const data = (value as { data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Relay repository list response is incompatible with this CLI");
    const repositories = (data as { repositories?: unknown }).repositories;
    if (!Array.isArray(repositories) || !repositories.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const repository = item as { id?: unknown; identity?: unknown; name?: unknown };
      return typeof repository.id === "string" && typeof repository.identity === "string" && typeof repository.name === "string";
    })) throw new Error("Relay repository list response is incompatible with this CLI");
    return repositories as Array<{ id: string; identity: string; name: string }>;
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

  async discovery(input: RelayDiscoveryQuery): Promise<RelayDiscoveryResult> {
    requireCloudIdentifier(input.repositoryId, "repositoryId");
    if (typeof input.includeIdle !== "boolean") throw new Error("Discovery includeIdle must be a boolean");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > DISCOVERY_PAGE_SIZE)) {
      throw new Error(`Discovery limit must be an integer from 1 to ${DISCOVERY_PAGE_SIZE}`);
    }
    const visited = new Set<string>();
    let cursor: string | null = null;
    let sessions: RelayDiscoverySession[] = [];
    let meta: RelayDiscoveryMeta = { reasonCode: null, matched: null, nextCursor: null };
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        repositoryId: input.repositoryId,
        includeIdle: input.includeIdle,
        limit: input.limit ?? DISCOVERY_PAGE_SIZE,
      };
      if (input.branch) body.branch = input.branch;
      if (input.provider) body.provider = input.provider;
      if (input.userFilterId) body.userFilterId = input.userFilterId;
      if (input.taskLabel) body.taskLabel = input.taskLabel;
      if (cursor !== null) body.cursor = cursor;
      const pageResult = parseDiscoveryResponse(await this.call<unknown>("POST", "/v1/discovery/query", body, undefined, true));
      sessions = sessions.concat(pageResult.sessions);
      meta = {
        ...pageResult.meta,
        matched: meta.matched ?? pageResult.meta.matched,
      };
      if (meta.nextCursor === null) break;
      if (visited.has(meta.nextCursor)) throw new Error("Relay returned a repeated discovery cursor");
      visited.add(meta.nextCursor);
      cursor = meta.nextCursor;
      if (page === DISCOVERY_MAX_PAGES - 1) throw new Error(`Relay discovery exceeded the ${DISCOVERY_MAX_PAGES}-page bound`);
    }
    return { sessions, meta };
  }

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string, readOnly = false): Promise<T> {
    if (!/^\/(?!\/)/u.test(path)) throw new Error("Relay paths must begin with exactly one slash");
    if (!readOnly && method !== "GET" && (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey))) {
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

/** @deprecated Use RelayClient instead */
export const SpikeClient = RelayClient;
