import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { platform } from "node:os";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";

const LOCAL_SECRET_BYTES = 32;
const LOCAL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MIN_EMPIRICAL_ENTROPY_BITS = 128;

export class InvalidLocalSecretError extends Error {
  constructor() {
    super("Pinboard local secret is invalid; refusing local daemon authentication");
    this.name = "InvalidLocalSecretError";
  }
}

function empiricalEntropyBits(value: Buffer): number {
  const counts = new Map<number, number>();
  for (const byte of value) counts.set(byte, (counts.get(byte) ?? 0) + 1);
  let bitsPerByte = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bitsPerByte -= probability * Math.log2(probability);
  }
  return bitsPerByte * value.length;
}

export function validateLocalSecret(value: string): string {
  if (!LOCAL_SECRET_PATTERN.test(value)) throw new InvalidLocalSecretError();
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== LOCAL_SECRET_BYTES ||
    decoded.toString("base64url") !== value ||
    empiricalEntropyBits(decoded) < MIN_EMPIRICAL_ENTROPY_BITS
  ) {
    throw new InvalidLocalSecretError();
  }
  return value;
}

async function readAndValidateSecret(paths: PinboardPaths): Promise<string> {
  return validateLocalSecret((await readFile(paths.secret, "utf8")).trim());
}

export async function readOrCreateLocalSecret(paths: PinboardPaths = getPaths()): Promise<string> {
  await ensureDirectories(paths);
  try {
    return await readAndValidateSecret(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = validateLocalSecret(randomBytes(LOCAL_SECRET_BYTES).toString("base64url"));
  try {
    await writeFile(paths.secret, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await readAndValidateSecret(paths);
  }
  if (platform() !== "win32") await chmod(paths.secret, 0o600);
  return secret;
}

export async function readLocalSecret(paths: PinboardPaths = getPaths()): Promise<string> {
  return readAndValidateSecret(paths);
}

export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = header.slice(7);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
