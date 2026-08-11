import { afterEach, describe, expect, it } from "vitest";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRelayToken, deleteRelayToken } from "../src/cloud/token-reader.js";
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
  it("reads the WorkOS device token only from the OS credential store", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const credentialStore = makeStore();
    await credentialStore.save("usepinboard-cli", "device-auth", "os_token_12345");
    const token = await readRelayToken(paths, { credentialStore });
    expect(token).toBe("os_token_12345");
  });

  it("requires WorkOS login when the OS credential store is empty", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const credentialStore = makeStore();
    await expect(readRelayToken(paths, { credentialStore })).rejects.toThrow(/pinboard auth login/u);
  });

  it("deletes the OS token and cleans up an obsolete static-token file without reading it", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const credentialStore = makeStore();
    await credentialStore.save("usepinboard-cli", "device-auth", "token_to_delete");
    const legacyFile = join(paths.dataDir, "cloud-credentials.json");
    await writeFile(legacyFile, JSON.stringify({ version: 1, token: "legacy_token_to_delete_1234" }));
    await deleteRelayToken(paths, { credentialStore });
    expect(credentialStore.deleted).toEqual(["deleted"]);
    await expect(access(legacyFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
