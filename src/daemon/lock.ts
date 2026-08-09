import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { PinboardPaths } from "../platform/paths.js";

type LockRecord = {
  pid: number;
  token: string;
};

export interface DaemonLock {
  release: () => Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 1 || typeof parsed.token !== "string") return null;
    return { pid: parsed.pid as number, token: parsed.token };
  } catch {
    return null;
  }
}

function processAppearsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

export async function acquireDaemonLock(
  paths: PinboardPaths,
  endpointIsOccupied: () => Promise<boolean>,
): Promise<DaemonLock> {
  const token = randomUUID();
  const record: LockRecord = { pid: process.pid, token };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(paths.lock, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });

      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          const current = await readLock(paths.lock);
          if (current?.token === token) await rm(paths.lock, { force: true });
        },
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    const existing = await readLock(paths.lock);
    if ((await endpointIsOccupied()) || (existing && processAppearsAlive(existing.pid))) {
      throw new Error(`A Pinboard daemon is already running for ${paths.dataDir}`);
    }
    await rm(paths.lock, { force: true });
  }

  throw new Error(`Could not acquire the Pinboard daemon lock at ${paths.lock}`);
}
