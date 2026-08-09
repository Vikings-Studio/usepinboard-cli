import { mkdtemp } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PinboardPaths } from "../src/platform/paths.js";

export async function temporaryPaths(): Promise<PinboardPaths> {
  const dataDir = await mkdtemp(join(tmpdir(), "pinboard-test-"));
  const runtimeDir = join(dataDir, "run");
  return {
    dataDir,
    runtimeDir,
    database: join(dataDir, "pinboard.sqlite3"),
    secret: join(runtimeDir, "local-secret"),
    lock: join(runtimeDir, "pinboardd.lock"),
    pid: join(runtimeDir, "pinboardd.pid"),
    log: join(runtimeDir, "pinboardd.log"),
    config: join(dataDir, "config.json"),
    cloudCredentials: join(dataDir, "cloud-credentials.json"),
    backups: join(dataDir, "backups"),
    marker: join(dataDir, ".pinboard-data"),
    socket: platform() === "win32" ? `\\\\.\\pipe\\pinboard-test-${randomUUID()}` : join(dataDir, "daemon.sock"),
  };
}
