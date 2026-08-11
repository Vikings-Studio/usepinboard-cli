import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RelayClient } from "../src/cloud/client.js";
import { resolveRepositoryLink } from "../src/cloud/repository-link.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function relayServer(repositories: unknown[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      calls.push({ method: request.method ?? "", path: request.url ?? "", body: raw ? JSON.parse(raw) as unknown : null });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ data: { repositories }, meta: { nextCursor: null } }));
      } else {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { repository: repositories[0] ?? null } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind");
  return { relay: new RelayClient(`http://127.0.0.1:${address.port}`, "relay_token_0123456789"), calls };
}

const repository = {
  identity: "https://github.com/Acme/API",
  name: "API",
  root: "/tmp/api",
  branch: "main",
};

describe("repository link resolution", () => {
  it("lets an ordinary member adopt an existing organization link without the admin mutation", async () => {
    const { relay, calls } = await relayServer([{
      id: "repo-existing",
      normalizedIdentity: "github.com/acme/api",
      linkedRemote: "git@github.com:Acme/API.git",
      name: "api",
    }]);

    await expect(resolveRepositoryLink({ relay, repository })).resolves.toEqual({
      repositoryId: "repo-existing",
      disposition: "adopted",
    });
    expect(calls).toEqual([{ method: "GET", path: "/v1/repositories?limit=100", body: null }]);
  });

  it("preserves owner/admin creation of a missing remote repository link", async () => {
    const { relay, calls } = await relayServer([]);
    await expect(resolveRepositoryLink({ relay, repository, requestedRepositoryId: "repo-new" })).resolves.toEqual({
      repositoryId: "repo-new",
      disposition: "created",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/repositories?limit=100" });
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/v1/repositories/link",
      body: { repositoryId: "repo-new", repositoryIdentity: repository.identity, repositoryName: repository.name },
    });
  });

  it("does not rebind an adopted repository under a conflicting requested id", async () => {
    const relay = {
      listRepositories: () => Promise.resolve([{
        id: "repo-existing", normalizedIdentity: "github.com/acme/api", linkedRemote: null, name: "api",
      }]),
      linkRepository: () => Promise.reject(new Error("must not mutate")),
    };
    await expect(resolveRepositoryLink({ relay, repository, requestedRepositoryId: "repo-other" }))
      .rejects.toThrow(/already linked to repo-existing/u);
  });
});
