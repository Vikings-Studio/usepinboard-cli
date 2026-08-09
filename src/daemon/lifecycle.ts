import { spawn } from "node:child_process";
import { open, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "./client.js";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";

export async function daemonIsHealthy(paths: PinboardPaths = getPaths()): Promise<boolean> {
  try {
    await new DaemonClient(paths).get<{ ok: boolean }>("/health");
    return true;
  } catch {
    return false;
  }
}

export async function startBackgroundDaemon(options: {
  executable: string;
  paths?: PinboardPaths;
}): Promise<number> {
  const paths = options.paths ?? getPaths();
  await ensureDirectories(paths);
  if (await daemonIsHealthy(paths)) {
    return Number((await readFile(paths.pid, "utf8")).trim()) || 0;
  }

  const log = await open(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [options.executable, "daemon", "run"], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  await log.close();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await daemonIsHealthy(paths)) return child.pid ?? 0;
    await delay(100);
  }
  throw new Error(`Pinboard daemon failed to start. See ${paths.log}`);
}

export async function stopBackgroundDaemon(paths: PinboardPaths = getPaths()): Promise<boolean> {
  if (!(await daemonIsHealthy(paths))) {
    await rm(paths.pid, { force: true });
    return false;
  }

  let pid: number;
  try {
    pid = Number((await readFile(paths.pid, "utf8")).trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Refusing to stop an invalid daemon PID");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await daemonIsHealthy(paths))) {
      await rm(paths.pid, { force: true });
      return true;
    }
    await delay(100);
  }
  return false;
}
