import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidLocalSecretError,
  readLocalSecret,
  readOrCreateLocalSecret,
  validateLocalSecret,
} from "../src/security/local-auth.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local daemon secret", () => {
  it("creates and re-reads a canonical 256-bit secret", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const created = await readOrCreateLocalSecret(paths);
    expect(Buffer.from(created, "base64url")).toHaveLength(32);
    expect(await readLocalSecret(paths)).toBe(created);
    expect(validateLocalSecret(created)).toBe(created);
  });

  it.each(["", "short", "A".repeat(43), `${randomBytes(32).toString("base64url")}!`])(
    "rejects malformed or low-entropy content without replacing it: %s",
    async (value) => {
      const paths = await temporaryPaths();
      cleanup.push(paths.dataDir);
      await readOrCreateLocalSecret(paths);
      await writeFile(paths.secret, `${value}\n`, "utf8");
      await expect(readLocalSecret(paths)).rejects.toBeInstanceOf(InvalidLocalSecretError);
      await expect(readOrCreateLocalSecret(paths)).rejects.toBeInstanceOf(InvalidLocalSecretError);
    },
  );
});
