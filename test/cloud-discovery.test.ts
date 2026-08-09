import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_MAX_PAGES, RelayClient, CloudClientError, type RelayDiscoverySession } from "../src/cloud/client.js";
import { cloudAwareWho } from "../src/cloud/discovery.js";
import type { PinboardConfig } from "../src/config/settings.js";
import type { SessionRecord } from "../src/domain/types.js";

type RelayHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  body: string,
) => void;

const openServers: Array<Server> = [];
afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function relayServer(handler: RelayHandler): Promise<{ apiUrl: string; requests: () => number }> {
  const state = { requests: 0 };
  const server = createServer((request, response) => {
    state.requests += 1;
    const url = new URL(request.url ?? "/", "http://localhost");
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => handler(request, response, url, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test relay did not bind");
  openServers.push(server);
  return { apiUrl: `http://127.0.0.1:${address.port}`, requests: () => state.requests };
}

function config(overrides: Partial<PinboardConfig["cloud"]> = {}): PinboardConfig {
  return {
    version: 2,
    idleMinutes: 5,
    staleMinutes: 30,
    cloud: { enabled: false, apiUrl: null, organizationId: null, userId: null, deviceId: null, syncPaused: false, ...overrides },
    auth: { deviceId: null },
  };
}

function localSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    address: "local/codex@repo~0123456789abcdef0123456789abcdef#main",
    provider: "codex",
    providerSessionId: "ps-1",
    repositoryIdentity: "https://github.com/example/repo",
    repositoryName: "repo",
    repositoryRoot: "/tmp/repo",
    branch: "main",
    taskLabel: null,
    pid: 123,
    state: "active",
    startedAt: "2026-08-10T00:00:00.000Z",
    lastActiveAt: "2026-08-10T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function cloudSession(overrides: Partial<RelayDiscoverySession> = {}): RelayDiscoverySession {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    repositoryId: "repo-1",
    provider: "claude-code",
    providerSessionId: "provider-session-1",
    branch: "feature",
    taskLabel: "refactor",
    state: "active",
    lastActiveAt: "2026-08-10T00:01:00.000Z",
    userId: "user_1",
    deviceId: "device_1",
    ...overrides,
  };
}

describe("relay discovery query", () => {
  it("posts only the contract fields and never tenant authority fields", async () => {
    const captured: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
    const { apiUrl } = await relayServer((request, response, _url, body) => {
      captured.push({
        headers: {
          authorization: request.headers.authorization,
          "x-pinboard-protocol-version": request.headers["x-pinboard-protocol-version"],
        },
        body: JSON.parse(body) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { sessions: [] }, meta: { reasonCode: null, matched: 1, nextCursor: null } }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    const result = await client.discovery({ repositoryId: "repo-1", includeIdle: true, branch: "main" });
    expect(result.meta).toEqual({ reasonCode: null, matched: 1, nextCursor: null });
    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.headers.authorization).toBe("Bearer relay_token_0123456789");
    expect(request?.headers["x-pinboard-protocol-version"]).toBe("1");
    expect(request?.body).toEqual({ repositoryId: "repo-1", includeIdle: true, limit: 100, branch: "main" });
    expect(request?.body).not.toHaveProperty("organizationId");
    expect(request?.body).not.toHaveProperty("userId");
    expect(request?.body).not.toHaveProperty("deviceId");
  });

  it("paginates on nextCursor and stops once it is null", async () => {
    const cursors: Array<string | null> = [];
    const { apiUrl } = await relayServer((_request, response, _url, body) => {
      const parsed = JSON.parse(body) as { cursor?: string };
      cursors.push(parsed.cursor ?? null);
      const first = cursors.length === 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: { sessions: first ? [cloudSession()] : [] },
        meta: { reasonCode: null, matched: first ? 2 : 1, nextCursor: first ? "c1" : null },
      }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    const result = await client.discovery({ repositoryId: "repo-1", includeIdle: false });
    expect(result.sessions).toHaveLength(1);
    expect(result.meta.matched).toBe(2);
    expect(cursors).toEqual([null, "c1"]);
  });

  it("detects a repeated discovery cursor", async () => {
    const { apiUrl } = await relayServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { sessions: [] }, meta: { reasonCode: null, matched: 1, nextCursor: "c1" } }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    await expect(client.discovery({ repositoryId: "repo-1", includeIdle: true })).rejects.toThrow(/repeated discovery cursor/u);
  });

  it("enforces the bounded page count", async () => {
    let count = 0;
    const { apiUrl, requests } = await relayServer((_request, response) => {
      count += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { sessions: [] }, meta: { reasonCode: null, matched: 1, nextCursor: `cursor_${count}` } }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    await expect(client.discovery({ repositoryId: "repo-1", includeIdle: true })).rejects.toThrow(/20-page bound/u);
    expect(requests()).toBe(DISCOVERY_MAX_PAGES);
  });

  it("rejects a malformed discovery envelope", async () => {
    const { apiUrl } = await relayServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { sessions: "not-an-array" }, meta: {} }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    await expect(client.discovery({ repositoryId: "repo-1", includeIdle: true })).rejects.toThrow(/incompatible/u);
  });

  it("rejects the obsolete boolean matched shape", async () => {
    const { apiUrl } = await relayServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { sessions: [] }, meta: { reasonCode: null, matched: true } }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    await expect(client.discovery({ repositoryId: "repo-1", includeIdle: true })).rejects.toThrow(/incompatible/u);
  });

  it("sanitizes session fields and reason codes", async () => {
    const { apiUrl } = await relayServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: { sessions: [{ ...cloudSession(), taskLabel: "\u001b[31mrefactor\u0007" }] },
        meta: { reasonCode: "ACCESS\u001b[31mDENIED\nnext", matched: 1, nextCursor: null },
      }));
    });
    const client = new RelayClient(apiUrl, "relay_token_0123456789");
    const result = await client.discovery({ repositoryId: "repo-1", includeIdle: true });
    expect(result.sessions[0]?.taskLabel).toBe("[31mrefactor");
    expect(result.meta.reasonCode).toBe("ACCESS[31mDENIED next");
    expect(JSON.stringify(result)).not.toContain("\u001b");
  });
});

describe("cloud-aware discovery coordinator", () => {
  it("returns local sessions with a disabled status when Cloud is off, without any relay call", async () => {
    const relay = { discovery: vi.fn() };
    const result = await cloudAwareWho({
      config: config(),
      repositoryIdentity: "https://github.com/example/repo",
      includeIdle: true,
      repositoryId: "repo-1",
      token: "token_0123456789",
      client: relay,
      listLocal: () => Promise.resolve([localSession()]),
    });
    expect(result.cloud).toEqual({ status: "disabled", reasonCode: null, matched: null, warning: null });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ origin: "local", id: "11111111-1111-4111-8111-111111111111" });
    expect(relay.discovery).not.toHaveBeenCalled();
  });

  it("returns local sessions with an unlinked status when Cloud is enabled but the repository is not linked", async () => {
    const relay = { discovery: vi.fn() };
    const result = await cloudAwareWho({
      config: config({ enabled: true, apiUrl: "http://127.0.0.1:9", organizationId: "org_1", userId: "user_1", deviceId: "device_1" }),
      repositoryIdentity: "https://github.com/example/repo",
      includeIdle: true,
      repositoryId: null,
      token: "token_0123456789",
      client: relay,
      listLocal: () => Promise.resolve([localSession()]),
    });
    expect(result.cloud.status).toBe("unlinked");
    expect(result.sessions).toHaveLength(1);
    expect(relay.discovery).not.toHaveBeenCalled();
  });

  it("merges, dedupes, and labels local and cloud sessions when connected", async () => {
    const second = cloudSession({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lastActiveAt: "2026-08-10T00:00:00.000Z" });
    const relay = {
      discovery: vi.fn(() => Promise.resolve({
        sessions: [cloudSession(), cloudSession(), second],
        meta: { reasonCode: "OK", matched: 1, nextCursor: null },
      })),
    };
    const result = await cloudAwareWho({
      config: config({ enabled: true, apiUrl: "http://127.0.0.1:9", organizationId: "org_1", userId: "user_1", deviceId: "device_1" }),
      repositoryIdentity: "https://github.com/example/repo",
      branch: "main",
      includeIdle: true,
      repositoryId: "repo-1",
      token: "token_0123456789",
      client: relay,
      listLocal: () => Promise.resolve([localSession()]),
    });
    expect(result.cloud).toEqual({ status: "connected", reasonCode: "OK", matched: 1, warning: null });
    expect(result.sessions).toHaveLength(3);
    expect(new Set(result.sessions.map((session) => session.origin))).toEqual(new Set(["local", "cloud"]));
    expect(result.sessions[0]).toMatchObject({ origin: "cloud", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId: "user_1", deviceId: "device_1" });
    expect(relay.discovery).toHaveBeenCalledTimes(1);
    expect(relay.discovery).toHaveBeenCalledWith({ repositoryId: "repo-1", includeIdle: true, branch: "main" });
  });

  it("preserves local machine-readable metadata and keeps cloud identity separate", async () => {
    const relay = {
      discovery: vi.fn(() => Promise.resolve({ sessions: [cloudSession()], meta: { reasonCode: null, matched: 0, nextCursor: null } })),
    };
    const result = await cloudAwareWho({
      config: config({ enabled: true, apiUrl: "http://127.0.0.1:9", organizationId: "org_1", userId: "user_1", deviceId: "device_1" }),
      repositoryIdentity: "https://github.com/example/repo",
      includeIdle: true,
      repositoryId: "repo-1",
      token: "token_0123456789",
      client: relay,
      listLocal: () => Promise.resolve([localSession()]),
    });
    const local = result.sessions.find((session) => session.origin === "local");
    const cloud = result.sessions.find((session) => session.origin === "cloud");
    expect(local).toMatchObject({ providerSessionId: "ps-1", pid: 123, repositoryRoot: "/tmp/repo" });
    expect(cloud).toMatchObject({ providerSessionId: "provider-session-1", pid: null, userId: "user_1", deviceId: "device_1" });
  });

  it("returns local results plus a sanitized warning when the Cloud fetch fails", async () => {
    const relay = {
      discovery: vi.fn(() => Promise.reject(new CloudClientError("network exploded\u001b[31m", "UNAVAILABLE", 503, "req_test"))),
    };
    const result = await cloudAwareWho({
      config: config({ enabled: true, apiUrl: "http://127.0.0.1:9", organizationId: "org_1", userId: "user_1", deviceId: "device_1" }),
      repositoryIdentity: "https://github.com/example/repo",
      includeIdle: true,
      repositoryId: "repo-1",
      token: "token_0123456789",
      client: relay,
      listLocal: () => Promise.resolve([localSession()]),
    });
    expect(result.cloud.status).toBe("degraded");
    expect(result.cloud.reasonCode).toBe("UNAVAILABLE");
    expect(result.cloud.warning).toContain("Cloud discovery unavailable (UNAVAILABLE)");
    expect(result.cloud.warning).toContain("network exploded[31m");
    expect(JSON.stringify(result.cloud.warning)).not.toContain("\u001b");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.origin).toBe("local");
  });

  it("treats Cloud as disabled when the credential is missing and never calls the relay", async () => {
    const relay = { discovery: vi.fn() };
    const result = await cloudAwareWho({
      config: config({ enabled: true, apiUrl: "http://127.0.0.1:9", organizationId: "org_1", userId: "user_1", deviceId: "device_1" }),
      repositoryIdentity: "https://github.com/example/repo",
      includeIdle: true,
      repositoryId: "repo-1",
      token: null,
      client: relay,
      listLocal: () => Promise.resolve([localSession()]),
    });
    expect(result.cloud.status).toBe("disabled");
    expect(relay.discovery).not.toHaveBeenCalled();
  });

  it("excludes only the caller's local session, never a cloud session", async () => {
    const relay = {
      discovery: vi.fn(() => Promise.resolve({
        sessions: [cloudSession({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })],
        meta: { reasonCode: null, matched: 1, nextCursor: null },
      })),
    };
    const result = await cloudAwareWho({
      config: config({ enabled: true, apiUrl: "http://127.0.0.1:9", organizationId: "org_1", userId: "user_1", deviceId: "device_1" }),
      repositoryIdentity: "https://github.com/example/repo",
      includeIdle: true,
      repositoryId: "repo-1",
      token: "token_0123456789",
      client: relay,
      listLocal: () => Promise.resolve([
        localSession(),
        localSession({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", lastActiveAt: "2026-08-10T00:02:00.000Z" }),
      ]),
      excludeSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.filter((session) => session.origin === "local")).toHaveLength(1);
    expect(result.sessions.filter((session) => session.id === "cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
      .toEqual([expect.objectContaining({ origin: "cloud" })]);
  });
});
