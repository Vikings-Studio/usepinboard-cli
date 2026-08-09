import { createHash } from "node:crypto";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { join, parse, resolve } from "node:path";
import { mkdir, chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "../storage/schema.js";

export interface PinboardPaths {
  dataDir: string;
  runtimeDir: string;
  database: string;
  secret: string;
  lock: string;
  pid: string;
  log: string;
  config: string;
  cloudCredentials: string;
  backups: string;
  marker: string;
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
    config: join(dataDir, "config.json"),
    cloudCredentials: join(dataDir, "cloud-credentials.json"),
    backups: join(dataDir, "backups"),
    marker: join(dataDir, ".pinboard-data"),
    socket,
  };
}

async function validLegacyPinboardDirectory(paths: PinboardPaths, entries: string[]): Promise<boolean> {
  const allowed = /^(?:pinboard\.sqlite3(?:-wal|-shm)?|run|backups|config\.json)$/u;
  if (entries.some((entry) => !allowed.test(entry)) || !entries.includes("pinboard.sqlite3") || !entries.includes("run")) return false;
  try {
    const databaseInfo = await lstat(paths.database);
    const secretInfo = await lstat(paths.secret);
    if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || !secretInfo.isFile() || secretInfo.isSymbolicLink()) return false;
    const secret = (await readFile(paths.secret, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret) || Buffer.from(secret, "base64url").length !== 32) return false;
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
      const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      if (integrity?.quick_check !== "ok" || !["schema_migrations", "local_identity", "sessions", "messages"].every((table) => tables.has(table))) return false;
      const version = Number((database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version?: unknown } | undefined)?.version);
      return Number.isInteger(version) && version > 0 && version <= SCHEMA_VERSION;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export async function ensureDirectories(paths = getPaths()): Promise<void> {
  let entries: string[] = [];
  let existed = true;
  try {
    const dataInfo = await lstat(paths.dataDir);
    if (dataInfo.isSymbolicLink() || !dataInfo.isDirectory()) {
      throw new Error(`Refusing unsafe Pinboard data directory: ${paths.dataDir}`);
    }
    entries = await readdir(paths.dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  if (existed && entries.length > 0 && !entries.includes(".pinboard-data")) {
    if (!(await validLegacyPinboardDirectory(paths, entries))) {
      throw new Error(`Refusing to initialize PINBOARD_HOME over an existing unmarked directory: ${paths.dataDir}`);
    }
  }
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.backups, { recursive: true, mode: 0o700 });
  try {
    const marker = await lstat(paths.marker);
    if (!marker.isFile() || marker.isSymbolicLink() || await readFile(paths.marker, "utf8") !== "pinboard-data-v1\n") {
      throw new Error(`Invalid Pinboard data marker: ${paths.marker}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await writeFile(paths.marker, "pinboard-data-v1\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST"
        || await readFile(paths.marker, "utf8").catch(() => "") !== "pinboard-data-v1\n") throw writeError;
    }
  }
  if (platform() !== "win32") {
    await chmod(paths.dataDir, 0o700);
    await chmod(paths.runtimeDir, 0o700);
    await chmod(paths.backups, 0o700);
  }
}

export async function validatePurgeTarget(dataDir: string, options: { cwd?: string; home?: string; marker?: string } = {}): Promise<string> {
  const target = resolve(dataDir);
  const systemRoot = parse(target).root;
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const isAncestor = (ancestor: string, child: string): boolean => child === ancestor || child.startsWith(`${ancestor}${process.platform === "win32" ? "\\" : "/"}`);
  if (target === systemRoot || isAncestor(target, home) || isAncestor(target, cwd) || target.length < 8) {
    throw new Error(`Refusing to purge unsafe Pinboard data path: ${target}`);
  }
  const markerPath = options.marker ?? join(target, ".pinboard-data");
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(markerPath, "utf8") !== "pinboard-data-v1\n") throw new Error("invalid marker");
  } catch {
    throw new Error(`Refusing to purge unowned data path without a valid Pinboard marker: ${target}`);
  }
  return target;
}
