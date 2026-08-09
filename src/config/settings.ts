import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { PinboardPaths } from "../platform/paths.js";
import { isCloudIdentifier } from "../cloud/identifiers.js";

export interface PinboardConfig {
  version: 2;
  idleMinutes: number;
  staleMinutes: number;
  cloud: CloudConfig;
  auth: AuthConfig;
}

export interface AuthConfig {
  deviceId: string | null;
}

export interface CloudConfig {
  enabled: boolean;
  apiUrl: string | null;
  organizationId: string | null;
  userId: string | null;
  deviceId: string | null;
  syncPaused: boolean;
}

export type ConfigKey = "idleMinutes" | "staleMinutes";

export const DEFAULT_CONFIG: PinboardConfig = {
  version: 2,
  idleMinutes: 5,
  staleMinutes: 30,
  cloud: {
    enabled: false,
    apiUrl: null,
    organizationId: null,
    userId: null,
    deviceId: null,
    syncPaused: false,
  },
  auth: {
    deviceId: null,
  },
};

function validate(value: unknown): PinboardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pinboard config must be a JSON object");
  const input = value as Record<string, unknown>;
  const idleMinutes = Number(input.idleMinutes ?? DEFAULT_CONFIG.idleMinutes);
  const staleMinutes = Number(input.staleMinutes ?? DEFAULT_CONFIG.staleMinutes);
  if (input.version !== undefined && input.version !== 1 && input.version !== 2) {
    const version = typeof input.version === "string" || typeof input.version === "number" ? String(input.version) : "invalid value";
    throw new Error(`Unsupported Pinboard config version: ${version}`);
  }
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) throw new Error("idleMinutes must be an integer from 1 to 1440");
  if (!Number.isInteger(staleMinutes) || staleMinutes <= idleMinutes || staleMinutes > 10_080) {
    throw new Error("staleMinutes must be an integer greater than idleMinutes and no more than 10080");
  }
  const rawCloud = input.version === 2 && input.cloud && typeof input.cloud === "object" && !Array.isArray(input.cloud)
    ? input.cloud as Record<string, unknown>
    : {};
  const rawAuth = input.version === 2 && input.auth && typeof input.auth === "object" && !Array.isArray(input.auth)
    ? input.auth as Record<string, unknown>
    : {};
  const nullableString = (key: string): string | null => {
    const item = rawCloud[key];
    if (item === undefined || item === null) return null;
    if (typeof item !== "string" || item.length === 0 || item.length > 2048) throw new Error(`cloud.${key} must be a non-empty string or null`);
    return item;
  };
  const apiUrl = nullableString("apiUrl");
  if (apiUrl !== null) {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
      throw new Error("cloud.apiUrl must use HTTPS except for loopback testing");
    }
  }
  for (const key of ["organizationId", "userId", "deviceId"] as const) {
    const identifier = nullableString(key);
    if (identifier !== null && !isCloudIdentifier(identifier)) throw new Error(`cloud.${key} must be a stable 1-128 character identifier or null`);
  }
  const authDeviceId = rawAuth.deviceId === undefined || rawAuth.deviceId === null
    ? null
    : (() => {
      if (typeof rawAuth.deviceId !== "string" || rawAuth.deviceId.length === 0 || rawAuth.deviceId.length > 128) {
        throw new Error("auth.deviceId must be a non-empty string or null");
      }
      return rawAuth.deviceId;
    })();
  return {
    version: 2,
    idleMinutes,
    staleMinutes,
    cloud: {
      enabled: rawCloud.enabled === true,
      apiUrl,
      organizationId: nullableString("organizationId"),
      userId: nullableString("userId"),
      deviceId: nullableString("deviceId"),
      syncPaused: rawCloud.syncPaused === true,
    },
    auth: {
      deviceId: authDeviceId,
    },
  };
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

export async function setCloudConfig(paths: PinboardPaths, cloud: CloudConfig): Promise<PinboardConfig> {
  const current = await readConfig(paths);
  const next = validate({ ...current, version: 2, cloud });
  await writeConfig(paths, next);
  return next;
}

export async function setAuthConfig(paths: PinboardPaths, auth: AuthConfig): Promise<PinboardConfig> {
  const current = await readConfig(paths);
  const next = validate({ ...current, version: 2, auth });
  await writeConfig(paths, next);
  return next;
}

export function parseConfigKey(value: string): ConfigKey {
  if (["idleMinutes", "staleMinutes"].includes(value)) return value as ConfigKey;
  throw new Error(`Unknown config key: ${value}`);
}
