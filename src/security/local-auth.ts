import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { platform } from "node:os";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";

export async function readOrCreateLocalSecret(paths: PinboardPaths = getPaths()): Promise<string> {
  await ensureDirectories(paths);
  try {
    return (await readFile(paths.secret, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.secret, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readFile(paths.secret, "utf8")).trim();
  }
  if (platform() !== "win32") await chmod(paths.secret, 0o600);
  return secret;
}

export async function readLocalSecret(paths: PinboardPaths = getPaths()): Promise<string> {
  return (await readFile(paths.secret, "utf8")).trim();
}

export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = header.slice(7);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
