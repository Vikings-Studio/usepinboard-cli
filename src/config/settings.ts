import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { PinboardPaths } from "../platform/paths.js";

export interface PinboardConfig {
  version: 1;
  idleMinutes: number;
  staleMinutes: number;
}

export type ConfigKey = "idleMinutes" | "staleMinutes";

export const DEFAULT_CONFIG: PinboardConfig = {
  version: 1,
  idleMinutes: 5,
  staleMinutes: 30,
};

function validate(value: unknown): PinboardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pinboard config must be a JSON object");
  const input = value as Record<string, unknown>;
  const idleMinutes = Number(input.idleMinutes ?? DEFAULT_CONFIG.idleMinutes);
  const staleMinutes = Number(input.staleMinutes ?? DEFAULT_CONFIG.staleMinutes);
  if (input.version !== undefined && input.version !== 1) {
    const version = typeof input.version === "string" || typeof input.version === "number" ? String(input.version) : "invalid value";
    throw new Error(`Unsupported Pinboard config version: ${version}`);
  }
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) throw new Error("idleMinutes must be an integer from 1 to 1440");
  if (!Number.isInteger(staleMinutes) || staleMinutes <= idleMinutes || staleMinutes > 10_080) {
    throw new Error("staleMinutes must be an integer greater than idleMinutes and no more than 10080");
  }
  return { version: 1, idleMinutes, staleMinutes };
}

export async function readConfig(paths: PinboardPaths): Promise<PinboardConfig> {
  try {
    return validate(JSON.parse(await readFile(paths.config, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    if (error instanceof SyntaxError) throw new Error(`Pinboard config is not valid JSON: ${paths.config}`);
    throw error;
  }
}

async function writeConfig(paths: PinboardPaths, config: PinboardConfig): Promise<void> {
  await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  const temporary = `${paths.config}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, paths.config);
}

export async function setConfig(paths: PinboardPaths, key: ConfigKey, rawValue: string): Promise<PinboardConfig> {
  const current = await readConfig(paths);
  const value: unknown = Number(rawValue);
  const next = validate({ ...current, [key]: value });
  await writeConfig(paths, next);
  return next;
}

export function parseConfigKey(value: string): ConfigKey {
  if (["idleMinutes", "staleMinutes"].includes(value)) return value as ConfigKey;
  throw new Error(`Unknown config key: ${value}`);
}
