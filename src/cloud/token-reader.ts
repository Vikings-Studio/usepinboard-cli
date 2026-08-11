import { createCredentialStore, type CredentialStore } from "../auth/credential-store.js";
import { DEVICE_AUTH_ACCOUNT, DEVICE_AUTH_SERVICE } from "../constants.js";
import type { PinboardPaths } from "../platform/paths.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export interface TokenReaderDependencies {
  credentialStore?: CredentialStore;
}

async function removeLegacyCredentialFile(paths: PinboardPaths): Promise<void> {
  // Migration cleanup only. This obsolete file is never read or accepted as
  // an authentication source; WorkOS device tokens live in the OS store.
  await rm(join(paths.dataDir, "cloud-credentials.json"), { force: true }).catch(() => undefined);
}

export async function readRelayToken(
  paths: PinboardPaths,
  deps: TokenReaderDependencies = {},
): Promise<string> {
  const store = deps.credentialStore ?? createCredentialStore();
  const stored = await store.read(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT);
  await removeLegacyCredentialFile(paths);
  if (stored) return stored;
  throw new Error("Pinboard Cloud is not authenticated. Run `pinboard auth login`.");
}

export async function deleteRelayToken(
  paths: PinboardPaths,
  deps: TokenReaderDependencies = {},
): Promise<void> {
  const store = deps.credentialStore ?? createCredentialStore();
  await store.delete(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT).catch(() => undefined);
  await removeLegacyCredentialFile(paths);
}
