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
    pid: join(runtimeDir, "pinboardd.pid"),
    log: join(runtimeDir, "pinboardd.log"),
    socket: platform() === "win32" ? `\\\\.\\pipe\\pinboard-test-${randomUUID()}` : join(dataDir, "daemon.sock"),
  };
}
