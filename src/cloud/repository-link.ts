import type { RepositoryContext } from "../domain/types.js";
import { normalizeGitRemote } from "../domain/repository.js";
import { deriveRepositoryId, isCloudIdentifier } from "./identifiers.js";
import type { RelayRepository } from "./client.js";

export interface RepositoryLinkRelay {
  listRepositories(): Promise<RelayRepository[]>;
  linkRepository(repositoryId: string, repositoryIdentity: string, repositoryName: string): Promise<void>;
}

export interface RepositoryLinkResolution {
  repositoryId: string;
  disposition: "adopted" | "created";
}

function identityKey(value: string): string {
  const normalized = normalizeGitRemote(value);
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "").split("/").filter(Boolean);
    if (segments.length >= 2) {
      const caseInsensitive = ["github.com", "gitlab.com", "bitbucket.org"].includes(host);
      const owner = caseInsensitive ? String(segments[0]).toLowerCase() : String(segments[0]);
      const repository = caseInsensitive ? String(segments[1]).toLowerCase() : String(segments[1]);
      return `${host}/${owner}/${repository}`;
    }
  } catch {
    // The relay's normalized identity is already host/owner/repository.
  }
  return normalized.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
}

function matchesLocalRepository(remote: RelayRepository, repository: RepositoryContext): boolean {
  const localKey = identityKey(repository.identity);
  return identityKey(remote.normalizedIdentity) === localKey
    || (remote.linkedRemote !== null && identityKey(remote.linkedRemote) === localKey);
}

// Existing organization links are read-only authorization state. Any active
// member can adopt one into their local daemon; only a missing remote link
// invokes the owner/admin-only mutation.
export async function resolveRepositoryLink(input: {
  relay: RepositoryLinkRelay;
  repository: RepositoryContext;
  requestedRepositoryId?: string;
}): Promise<RepositoryLinkResolution> {
  if (input.requestedRepositoryId && !isCloudIdentifier(input.requestedRepositoryId)) {
    throw new Error("--repository-id must be a stable 1-128 character identifier");
  }

  const repositories = await input.relay.listRepositories();
  const existing = repositories.find((candidate) => matchesLocalRepository(candidate, input.repository));
  if (existing) {
    if (input.requestedRepositoryId && input.requestedRepositoryId !== existing.id) {
      throw new Error(`This repository is already linked to ${existing.id}; omit --repository-id or use that ID`);
    }
    return { repositoryId: existing.id, disposition: "adopted" };
  }

  const repositoryId = input.requestedRepositoryId ?? deriveRepositoryId(input.repository.identity);
  await input.relay.linkRepository(repositoryId, input.repository.identity, input.repository.name);
  return { repositoryId, disposition: "created" };
}
