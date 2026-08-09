import { chmod, lstat, readFile, rm, symlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readCloudCredential, removeCloudCredential, writeCloudCredential } from "../src/cloud/credentials.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("cloud credential file", () => {
  it("stores a token restrictively without exposing it through config", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const token = "relay_token_0123456789";
    if (process.platform === "win32") {
      await expect(writeCloudCredential(paths, token)).rejects.toThrow(/unavailable on Windows; Personal remains supported/u);
      return;
    }
    await writeCloudCredential(paths, token);
    expect(await readCloudCredential(paths)).toBe(token);
    expect(JSON.parse(await readFile(paths.cloudCredentials, "utf8"))).toEqual({ version: 1, token });
    expect((await lstat(paths.cloudCredentials)).mode & 0o777).toBe(0o600);
    await removeCloudCredential(paths);
    await expect(readCloudCredential(paths)).rejects.toThrow(/not connected/u);
  });

  it("refuses broad permissions and symlinks", async () => {
    if (process.platform === "win32") return;
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    await writeCloudCredential(paths, "relay_token_0123456789");
    await chmod(paths.cloudCredentials, 0o644);
    await expect(readCloudCredential(paths)).rejects.toThrow(/permissions/u);
    await rm(paths.cloudCredentials);
    await symlink(paths.config, paths.cloudCredentials);
    await expect(readCloudCredential(paths)).rejects.toThrow(/unsafe/u);
  });
});
