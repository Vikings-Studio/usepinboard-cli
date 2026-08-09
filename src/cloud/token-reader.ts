import { createCredentialStore, type CredentialStore } from "../auth/credential-store.js";
import { DEVICE_AUTH_ACCOUNT, DEVICE_AUTH_SERVICE } from "../constants.js";
import type { PinboardPaths } from "../platform/paths.js";

export interface TokenReaderDependencies {
  credentialStore?: CredentialStore;
  legacyFallback?: (paths: PinboardPaths) => Promise<string>;
}

export async function readRelayToken(
  paths: PinboardPaths,
  deps: TokenReaderDependencies = {},
): Promise<string> {
  const store = deps.credentialStore ?? createCredentialStore();
  const stored = await store.read(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT);
  if (stored) return stored;
  if (deps.legacyFallback) return deps.legacyFallback(paths);
  const { readCloudCredential } = await import("./credentials.js");
  return readCloudCredential(paths);
}

export async function deleteRelayToken(
  paths: PinboardPaths,
  deps: TokenReaderDependencies = {},
): Promise<void> {
  const store = deps.credentialStore ?? createCredentialStore();
  await store.delete(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT).catch(() => undefined);
  const { removeCloudCredential } = await import("./credentials.js");
  await removeCloudCredential(paths).catch(() => undefined);
}
