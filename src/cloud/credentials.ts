import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { PinboardPaths } from "../platform/paths.js";

interface StoredCredential {
  version: 1;
  token: string;
}

export function validateStaticToken(value: string): string {
  const token = value.trim();
  let unsafe = false;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) unsafe = true;
  }
  if (token.length < 16 || token.length > 4096 || unsafe) {
    throw new Error("The design-partner token is invalid");
  }
  return token;
}

async function assertSafeCredentialFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe cloud credential file: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`Cloud credential file is not owned by this user: ${path}`);
  if (platform() !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`Cloud credential file permissions are too broad: ${path}`);
}

export async function writeCloudCredential(paths: PinboardPaths, rawToken: string): Promise<void> {
  if (platform() === "win32") throw new Error("Experimental Teams relay credentials are unavailable on Windows; Personal remains supported");
  const token = validateStaticToken(rawToken);
  await mkdir(dirname(paths.cloudCredentials), { recursive: true, mode: 0o700 });
  try {
    await assertSafeCredentialFile(paths.cloudCredentials);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${paths.cloudCredentials}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    const value: StoredCredential = { version: 1, token };
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (platform() === "win32") {
    const previous = `${paths.cloudCredentials}.${process.pid}.previous`;
    let movedPrevious = false;
    try {
      await rename(paths.cloudCredentials, previous);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    try {
      await rename(temporary, paths.cloudCredentials);
      if (movedPrevious) await rm(previous, { force: true });
    } catch (error) {
      if (movedPrevious) await rename(previous, paths.cloudCredentials).catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  } else {
    await rename(temporary, paths.cloudCredentials);
  }
  if (platform() !== "win32") await chmod(paths.cloudCredentials, 0o600);
}

export async function readCloudCredential(paths: PinboardPaths): Promise<string> {
  if (platform() === "win32") throw new Error("Experimental Teams relay credentials are unavailable on Windows; Personal remains supported");
  try {
    await assertSafeCredentialFile(paths.cloudCredentials);
    const parsed = JSON.parse(await readFile(paths.cloudCredentials, "utf8")) as Partial<StoredCredential>;
    if (parsed.version !== 1 || typeof parsed.token !== "string") throw new Error("Unsupported cloud credential format");
    return validateStaticToken(parsed.token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Pinboard Cloud is not connected. Run `pinboard cloud connect`.");
    if (error instanceof SyntaxError) throw new Error(`Cloud credential file is malformed: ${paths.cloudCredentials}`);
    throw error;
  }
}

export async function removeCloudCredential(paths: PinboardPaths): Promise<void> {
  try {
    const info = await lstat(paths.cloudCredentials);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe cloud credential file: ${paths.cloudCredentials}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`Cloud credential file is not owned by this user: ${paths.cloudCredentials}`);
    await rm(paths.cloudCredentials);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
