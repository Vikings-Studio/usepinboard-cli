import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { ensureDirectories, validatePurgeTarget } from "../src/platform/paths.js";
import { readOrCreateLocalSecret } from "../src/security/local-auth.js";
import { PinboardDatabase } from "../src/storage/database.js";
import { temporaryPaths } from "./helpers.js";

describe("purge target validation", () => {
  it("accepts only a scoped directory with a valid Pinboard marker", async () => {
    const paths = await temporaryPaths();
    await ensureDirectories(paths);
    await expect(validatePurgeTarget(paths.dataDir, {
      cwd: "/workspace/project",
      home: "/Users/example",
      marker: paths.marker,
    })).resolves.toBe(resolve(paths.dataDir));
  });

  it.each(["/", "/Users/example", "/workspace/project"])("rejects broad target %s", async (target) => {
    await expect(validatePurgeTarget(target, { cwd: "/workspace/project", home: "/Users/example" })).rejects.toThrow(
      /Refusing to purge unsafe/u,
    );
  });

  it("rejects unmarked targets and initialization over unrelated data", async () => {
    const paths = await temporaryPaths();
    await expect(validatePurgeTarget(paths.dataDir, { cwd: "/workspace", home: "/Users/example" })).rejects.toThrow(/unowned/u);
    await writeFile(join(paths.dataDir, "customer-data.txt"), "keep", "utf8");
    await expect(ensureDirectories(paths)).rejects.toThrow(/existing unmarked directory/u);
  });

  it("never claims an existing directory containing only a generic config file", async () => {
    const paths = await temporaryPaths();
    await writeFile(join(paths.dataDir, "config.json"), "{}\n", "utf8");
    await expect(ensureDirectories(paths)).rejects.toThrow(/existing unmarked directory/u);
    await expect(validatePurgeTarget(paths.dataDir, { cwd: "/workspace", home: "/Users/example" })).rejects.toThrow(/unowned/u);
  });

  it("adopts a validated pre-marker Pinboard layout without losing data", async () => {
    const paths = await temporaryPaths();
    await readOrCreateLocalSecret(paths);
    const database = await PinboardDatabase.open(paths);
    database.localIdentity();
    database.close();
    await rm(paths.marker);
    await expect(ensureDirectories(paths)).resolves.toBeUndefined();
    await expect(validatePurgeTarget(paths.dataDir, { cwd: "/workspace", home: "/Users/example" })).resolves.toBe(resolve(paths.dataDir));
  });
});
