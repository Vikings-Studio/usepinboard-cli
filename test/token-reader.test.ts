import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { readRelayToken, deleteRelayToken } from "../src/cloud/token-reader.js";
import { readCloudCredential, writeCloudCredential } from "../src/cloud/credentials.js";
import type { CredentialStore } from "../src/auth/credential-store.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function makeStore(): CredentialStore & { saved: string[]; deleted: string[] } {
  const saved: string[] = [];
  const deleted: string[] = [];
  return {
    saved,
    deleted,
    save(_service, _account, secret) { saved.push(secret); return Promise.resolve(); },
    read() { return Promise.resolve(saved.at(-1) ?? null); },
    delete() { deleted.push("deleted"); return Promise.resolve(); },
  };
}

describe("token reader", () => {
  it("prefers the OS credential store over the legacy fallback", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const credentialStore = makeStore();
    await credentialStore.save("usepinboard-cli", "device-auth", "os_token_12345");
    const token = await readRelayToken(paths, {
      credentialStore,
      legacyFallback: () => Promise.reject(new Error("should not reach legacy fallback")),
    });
    expect(token).toBe("os_token_12345");
  });

  it("falls back to the legacy credential file when the OS store is empty", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const credentialStore = makeStore();
    const token = await readRelayToken(paths, {
      credentialStore,
      legacyFallback: () => Promise.resolve("legacy_token_12345"),
    });
    expect(token).toBe("legacy_token_12345");
  });

  it("deletes from both the OS store and the legacy credential file", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const credentialStore = makeStore();
    await credentialStore.save("usepinboard-cli", "device-auth", "token_to_delete");
    if (process.platform !== "win32") await writeCloudCredential(paths, "legacy_token_to_delete_1234");
    await deleteRelayToken(paths, { credentialStore });
    expect(credentialStore.deleted).toEqual(["deleted"]);
    if (process.platform !== "win32") {
      await expect(readCloudCredential(paths)).rejects.toThrow(/not connected/u);
    }
  });
});
