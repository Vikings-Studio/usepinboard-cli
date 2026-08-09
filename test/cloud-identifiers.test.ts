import { describe, expect, it } from "vitest";
import { deriveRepositoryId, isCloudIdentifier } from "../src/cloud/identifiers.js";
import { normalizeGitRemote } from "../src/domain/repository.js";

describe("deriveRepositoryId", () => {
  it("derives a deterministic repo- prefixed SHA256 identifier", () => {
    const identity = "https://github.com/example/api";
    const first = deriveRepositoryId(identity);
    const second = deriveRepositoryId(identity);
    expect(first).toBe(second);
    expect(first).toMatch(/^repo-[0-9a-f]{32}$/u);
    expect(isCloudIdentifier(first)).toBe(true);
  });

  it("keeps distinct repository identities distinct", () => {
    const a = deriveRepositoryId("https://github.com/example/api");
    const b = deriveRepositoryId("https://github.com/example/web");
    expect(a).not.toBe(b);
  });

  it("hashes the normalized remote so equivalent Git remotes collide", () => {
    const scp = deriveRepositoryId(normalizeGitRemote("git@github.com:example/api.git"));
    const https = deriveRepositoryId(normalizeGitRemote("https://github.com/example/api"));
    expect(scp).toBe(https);
  });
});
