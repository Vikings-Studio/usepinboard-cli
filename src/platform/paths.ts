import { createHash } from "node:crypto";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

export interface PinboardPaths {
  dataDir: string;
  runtimeDir: string;
  database: string;
  secret: string;
  lock: string;
  pid: string;
  log: string;
  socket: string;
}

function defaultDataDir(): string {
  const override = process.env.PINBOARD_HOME;
  if (override) return override;

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Pinboard");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Pinboard");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pinboard");
}

export function getPaths(): PinboardPaths {
  const dataDir = defaultDataDir();
  const runtimeDir = join(dataDir, "run");
  const userKey = createHash("sha256")
    .update(`${userInfo().username}:${dataDir}`)
    .digest("hex")
    .slice(0, 12);
  const socket =
    platform() === "win32"
      ? `\\\\.\\pipe\\pinboard-${userKey}`
      : join(tmpdir(), `pinboard-${userKey}.sock`);

  return {
    dataDir,
    runtimeDir,
    database: join(dataDir, "pinboard.sqlite3"),
    secret: join(runtimeDir, "local-secret"),
    lock: join(runtimeDir, "pinboardd.lock"),
    pid: join(runtimeDir, "pinboardd.pid"),
    log: join(runtimeDir, "pinboardd.log"),
    socket,
  };
}

export async function ensureDirectories(paths = getPaths()): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") {
    await chmod(paths.dataDir, 0o700);
    await chmod(paths.runtimeDir, 0o700);
  }
}
