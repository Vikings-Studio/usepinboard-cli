import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { normalizeCloudApiUrl, RelayClient, SpikeClient } from "../src/cloud/client.js";
import { isCloudIdentifier, isCloudResourceId } from "../src/cloud/identifiers.js";

describe("relay client", () => {
  it("accepts backend stable identifiers and keeps resource UUIDs distinct", () => {
    expect(isCloudIdentifier("org.acme:west-1")).toBe(true);
    expect(isCloudIdentifier("user.name:dev")).toBe(true);
    expect(isCloudIdentifier(`a${"b".repeat(127)}`)).toBe(true);
    for (const invalid of [".leading", ":leading", "_leading", "-leading", `a${"b".repeat(128)}`, "has/slash", "has space"]) {
      expect(isCloudIdentifier(invalid)).toBe(false);
    }
    expect(isCloudResourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
    expect(isCloudResourceId("remote_session_1")).toBe(false);
  });

  it("rejects cleartext non-loopback and credential-bearing URLs before a request", () => {
    expect(() => new RelayClient("http://relay.example.test", "relay_token_0123456789")).toThrow(/HTTPS/u);
    expect(() => normalizeCloudApiUrl("https://user:pass@relay.example.test")).toThrow(/credentials/u);
    expect(normalizeCloudApiUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  });

  it("rejects escaped paths and invalid mutation idempotency before a request", async () => {
    const client = new RelayClient("http://127.0.0.1:1", "relay_token_0123456789");
    await expect(client.get("//attacker.example.test/v1/bootstrap")).rejects.toThrow(/exactly one slash/u);
    await expect(client.get("/\\attacker.example.test/v1/bootstrap")).rejects.toThrow(/origin/u);
    await expect(client.post("/v1/messages", {}, "short")).rejects.toThrow(/idempotency/u);
  });

  it("refuses redirects rather than forwarding bearer credentials", async () => {
    let targetRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/v1/bootstrap") {
        response.writeHead(302, { location: "/target" }).end();
      } else {
        targetRequests += 1;
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    try {
      const client = new RelayClient(`http://127.0.0.1:${address.port}`, "relay_token_0123456789");
      await expect(client.bootstrap()).rejects.toThrow();
      expect(targetRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("links a repository on /v1/repositories/link with a deterministic safe idempotency key", async () => {
    const requests: Array<{ path: string; key: string | null; body: string }> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        requests.push({
          path: url.pathname,
          key: (request.headers["idempotency-key"] as string | undefined) ?? null,
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { repository: { id: "repo-1", identity: "https://github.com/example/api", name: "api" } } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    try {
      const client = new RelayClient(`http://127.0.0.1:${address.port}`, "relay_token_0123456789");
      const repositoryId = "repo-abcdef0123456789abcdef0123456789";
      await client.linkRepository(repositoryId, "https://github.com/example/api", "api");
      expect(requests).toEqual([{
        path: "/v1/repositories/link",
        key: repositoryId,
        body: JSON.stringify({ repositoryId, repositoryIdentity: "https://github.com/example/api", repositoryName: "api" }),
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects an unsafe repository id before any request", async () => {
    const client = new RelayClient("http://127.0.0.1:1", "relay_token_0123456789");
    await expect(client.linkRepository("repo/has/slash", "https://github.com/example/api", "api")).rejects.toThrow(/identifier/u);
  });

  it("parses the repository list envelope", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { repositories: [{
        id: "repo-1",
        normalizedIdentity: "github.com/example/api",
        linkedRemote: "https://github.com/example/api",
        name: "api",
      }] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    try {
      const client = new RelayClient(`http://127.0.0.1:${address.port}`, "relay_token_0123456789");
      await expect(client.listRepositories()).resolves.toEqual([{
        id: "repo-1",
        normalizedIdentity: "github.com/example/api",
        linkedRemote: "https://github.com/example/api",
        name: "api",
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a malformed repository list envelope", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { repositories: "not-an-array" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    try {
      const client = new RelayClient(`http://127.0.0.1:${address.port}`, "relay_token_0123456789");
      await expect(client.listRepositories()).rejects.toThrow(/incompatible/u);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps the deprecated SpikeClient alias resolved to the active RelayClient", () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(SpikeClient).toBe(RelayClient);
  });

  it("sanitizes relay-controlled error text before it reaches terminal callers", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json", "x-request-id": "req_test" });
      response.end(JSON.stringify({ error: { code: "BAD\u001b[31m", message: "denied\u001b[2J\nnext" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    try {
      const client = new RelayClient(`http://127.0.0.1:${address.port}`, "relay_token_0123456789");
      const error = await client.bootstrap().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ message: "denied[2J next", code: "BAD[31m", requestId: "req_test" });
      expect(JSON.stringify(error)).not.toContain("\u001b");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
