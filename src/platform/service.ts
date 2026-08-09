import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type ServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

export interface ServiceDefinition {
  platform: ServicePlatform;
  path: string | null;
  content: string | null;
  supported: boolean;
  label: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface PreviousServiceState {
  loaded: boolean;
  enabled: boolean;
  running: boolean;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr || result.error?.message || "",
  };
};

function safeExecutable(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error("Service executable paths cannot be empty or contain control characters");
  return value;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function isOwnedDefinition(content: string, servicePlatform: ServicePlatform): boolean {
  if (servicePlatform === "darwin") {
    return content.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by @usepinboard/cli -->\n<!DOCTYPE plist ')
      && content.includes("<key>Label</key><string>com.usepinboard.pinboardd</string>");
  }
  if (servicePlatform === "linux") {
    return content.startsWith("# Managed by @usepinboard/cli\n[Unit]\n")
      && content.includes("\nDescription=Pinboard local coding-agent daemon\n");
  }
  return false;
}

export function serviceDefinition(options: {
  nodeExecutable: string;
  cliExecutable: string;
  logPath?: string;
  pinboardHome?: string;
  home?: string;
  platform?: NodeJS.Platform;
}): ServiceDefinition {
  const nodeExecutable = safeExecutable(options.nodeExecutable);
  const cliExecutable = safeExecutable(options.cliExecutable);
  const home = options.home ?? homedir();
  const currentPlatform = options.platform ?? platform();
  if (["darwin", "linux"].includes(currentPlatform) && (!isAbsolute(nodeExecutable) || !isAbsolute(cliExecutable))) {
    throw new Error("User services require absolute Node and Pinboard CLI paths");
  }
  const logPath = safeExecutable(options.logPath ?? join(home, ".local", "state", "pinboard", "pinboardd.log"));
  const pinboardHome = options.pinboardHome ? safeExecutable(options.pinboardHome) : null;
  if (["darwin", "linux"].includes(currentPlatform) && pinboardHome && !isAbsolute(pinboardHome)) {
    throw new Error("PINBOARD_HOME in a user service must be an absolute path");
  }
  if (currentPlatform === "darwin") {
    const label = "com.usepinboard.pinboardd";
    return {
      platform: "darwin",
      supported: true,
      label,
      path: join(home, "Library", "LaunchAgents", `${label}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by @usepinboard/cli -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(nodeExecutable)}</string>\n    <string>${xml(cliExecutable)}</string>\n    <string>daemon</string>\n    <string>run</string>\n  </array>${pinboardHome ? `\n  <key>EnvironmentVariables</key><dict><key>PINBOARD_HOME</key><string>${xml(pinboardHome)}</string></dict>` : ""}\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ProcessType</key><string>Background</string>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>Umask</key><integer>63</integer>\n  <key>StandardOutPath</key><string>${xml(logPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(logPath)}</string>\n</dict>\n</plist>\n`,
    };
  }
  if (currentPlatform === "linux") {
    const label = "pinboard.service";
    return {
      platform: "linux",
      supported: true,
      label,
      path: join(options.home === undefined ? process.env.XDG_CONFIG_HOME ?? join(home, ".config") : join(home, ".config"), "systemd", "user", label),
      content: `# Managed by @usepinboard/cli\n[Unit]\nDescription=Pinboard local coding-agent daemon\nDocumentation=https://github.com/Vikings-Studio/usepinboard-cli\n\n[Service]\nType=simple\nExecStart=${systemdArgument(nodeExecutable)} ${systemdArgument(cliExecutable)} daemon run${pinboardHome ? `\nEnvironment=${systemdArgument(`PINBOARD_HOME=${pinboardHome}`)}` : ""}\nRestart=on-failure\nRestartSec=2\nUMask=0077\nNoNewPrivileges=true\nRestrictSUIDSGID=true\nStandardOutput=append:${systemdArgument(logPath)}\nStandardError=append:${systemdArgument(logPath)}\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  return {
    platform: currentPlatform === "win32" ? "win32" : "unsupported",
    supported: false,
    label: "pinboard",
    path: null,
    content: null,
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pinboard-${process.pid}-${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, path);
}

async function writeChanged(path: string, content: string): Promise<{ changed: boolean; previous: string | null }> {
  let previous: string | null = null;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to replace unsafe service definition: ${path}`);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) throw new Error(`Refusing to replace a service definition owned by another user: ${path}`);
    const existing = await readFile(path, "utf8");
    if (existing === content) return { changed: false, previous: existing };
    const servicePlatform = path.endsWith(".plist") ? "darwin" : "linux";
    if (!isOwnedDefinition(existing, servicePlatform)) {
      throw new Error(`Refusing to replace a service definition not owned by Pinboard: ${path}`);
    }
    previous = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A missing file is the normal first-install case.
  }
  await writeAtomic(path, content);
  return { changed: true, previous };
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || "command failed").trim();
  throw new Error(`${operation}: ${detail}`);
}

export async function installUserService(
  definition: ServiceDefinition,
  runner: CommandRunner = defaultRunner,
): Promise<{ changed: boolean; created: boolean; previousContent: string | null; previousState: PreviousServiceState; path: string }> {
  if (!definition.supported || !definition.path || !definition.content) {
    throw new Error("Automatic user-service installation is supported on macOS and Linux; Windows remains best-effort beta");
  }
  if (process.getuid?.() === 0) throw new Error("Refusing to install a per-user Pinboard service as root");
  const uid = process.getuid?.();
  const macTarget = definition.platform === "darwin" && uid !== undefined ? `gui/${uid}/${definition.label}` : null;
  const macStatus = macTarget ? runner("launchctl", ["print", macTarget]) : null;
  const wasLoaded = macStatus?.status === 0;
  const wasRunning = definition.platform === "darwin"
    ? macStatus !== null && wasLoaded && /\bstate\s*=\s*running\b/iu.test(macStatus.stdout)
    : runner("systemctl", ["--user", "is-active", "--quiet", definition.label]).status === 0;
  const wasEnabled = definition.platform === "linux"
    ? runner("systemctl", ["--user", "is-enabled", "--quiet", definition.label]).status === 0
    : false;
  const write = await writeChanged(definition.path, definition.content);
  try {
    if (definition.platform === "darwin") {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("Cannot determine the macOS user ID for launchd");
      const domain = `gui/${uid}`;
      const target = `${domain}/${definition.label}`;
      const loaded = runner("launchctl", ["print", target]).status === 0;
      if (write.changed && loaded) requireSuccess(runner("launchctl", ["bootout", target]), "Could not unload the previous Pinboard launch agent");
      if (write.changed || !loaded) requireSuccess(runner("launchctl", ["bootstrap", domain, definition.path]), "Could not load the Pinboard launch agent");
      requireSuccess(runner("launchctl", ["kickstart", "-k", target]), "Could not start the Pinboard launch agent");
    } else {
      requireSuccess(runner("systemctl", ["--user", "daemon-reload"]), "Could not reload systemd user units");
      requireSuccess(runner("systemctl", ["--user", "enable", "--now", definition.label]), "Could not enable the Pinboard user service");
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    const rollback = (result: CommandResult, operation: string): void => {
      if (result.status !== 0) rollbackFailures.push(`${operation}: ${(result.stderr || result.stdout || "command failed").trim()}`);
    };
    if (write.changed) {
      if (definition.platform === "darwin" && macTarget && runner("launchctl", ["print", macTarget]).status === 0) {
        rollback(runner("launchctl", ["bootout", macTarget]), "unload partial launch agent");
      }
      if (definition.platform === "linux") {
        const nowEnabled = runner("systemctl", ["--user", "is-enabled", "--quiet", definition.label]).status === 0;
        const nowRunning = runner("systemctl", ["--user", "is-active", "--quiet", definition.label]).status === 0;
        if (nowEnabled || nowRunning) rollback(runner("systemctl", ["--user", "disable", "--now", definition.label]), "disable partial systemd service");
      }
      try {
        if (write.previous === null) await rm(definition.path, { force: true });
        else await writeAtomic(definition.path, write.previous);
      } catch (restoreError) {
        rollbackFailures.push(`restore ${definition.path}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
      if (definition.platform === "linux") {
        rollback(runner("systemctl", ["--user", "daemon-reload"]), "reload restored systemd units");
        if (write.previous !== null && wasEnabled) rollback(runner("systemctl", ["--user", "enable", definition.label]), "re-enable previous systemd service");
        if (write.previous !== null && wasRunning) rollback(runner("systemctl", ["--user", "start", definition.label]), "restart previous systemd service");
      } else if (write.previous !== null && wasLoaded && uid !== undefined) {
        rollback(runner("launchctl", ["bootstrap", `gui/${uid}`, definition.path]), "reload previous launch agent");
        rollback(runner("launchctl", ["kickstart", `gui/${uid}/${definition.label}`]), "restart previous launch agent");
      }
    }
    try {
      restoreUserServiceManagerState(definition, { loaded: wasLoaded, enabled: wasEnabled, running: wasRunning }, runner);
    } catch (stateError) {
      rollbackFailures.push(`restore prior service-manager state: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
    }
    if (rollbackFailures.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(`${original}\nRollback was incomplete:\n- ${rollbackFailures.join("\n- ")}\nInspect ${definition.path} and the user service manager before retrying.`);
    }
    throw error;
  }
  return {
    changed: write.changed,
    created: write.changed && write.previous === null,
    previousContent: write.previous,
    previousState: { loaded: wasLoaded, enabled: wasEnabled, running: wasRunning },
    path: definition.path,
  };
}

export function restoreUserServiceManagerState(
  definition: ServiceDefinition,
  state: PreviousServiceState,
  runner: CommandRunner = defaultRunner,
): void {
  if (!definition.supported) return;
  if (definition.platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Cannot determine the macOS user ID for launchd rollback");
    if (!definition.path) throw new Error("Cannot restore launchd state without a service definition path");
    const domain = `gui/${uid}`;
    const target = `gui/${uid}/${definition.label}`;
    let status = runner("launchctl", ["print", target]);
    if (!state.loaded && status.status === 0) {
      requireSuccess(runner("launchctl", ["bootout", target]), "Could not restore the prior unloaded launchd state");
      return;
    }
    if (state.loaded && status.status !== 0) {
      requireSuccess(runner("launchctl", ["bootstrap", domain, definition.path]), "Could not restore the prior loaded launchd state");
      status = runner("launchctl", ["print", target]);
    }
    const isRunning = status.status === 0 && /\bstate\s*=\s*running\b/iu.test(status.stdout);
    if (state.running && !isRunning) {
      requireSuccess(runner("launchctl", ["kickstart", target]), "Could not restore the prior running launchd state");
    } else if (!state.running && isRunning) {
      requireSuccess(runner("launchctl", ["kill", "SIGTERM", target]), "Could not restore the prior stopped launchd state");
    }
    return;
  }
  const isEnabled = runner("systemctl", ["--user", "is-enabled", "--quiet", definition.label]).status === 0;
  if (state.enabled && !isEnabled) {
    requireSuccess(runner("systemctl", ["--user", "enable", definition.label]), "Could not restore the prior enabled systemd state");
  } else if (!state.enabled && isEnabled) {
    requireSuccess(runner("systemctl", ["--user", "disable", definition.label]), "Could not restore the prior disabled systemd state");
  }
  const isRunning = runner("systemctl", ["--user", "is-active", "--quiet", definition.label]).status === 0;
  if (state.running && !isRunning) {
    requireSuccess(runner("systemctl", ["--user", "start", definition.label]), "Could not restore the prior running systemd state");
  } else if (!state.running && isRunning) {
    requireSuccess(runner("systemctl", ["--user", "stop", definition.label]), "Could not restore the prior stopped systemd state");
  }
}

export async function removeUserService(
  definition: ServiceDefinition,
  runner: CommandRunner = defaultRunner,
): Promise<boolean> {
  if (!definition.supported || !definition.path) return false;
  try {
    const info = await lstat(definition.path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to remove unsafe service definition: ${definition.path}`);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) throw new Error(`Refusing to remove a service definition owned by another user: ${definition.path}`);
    const existing = await readFile(definition.path, "utf8");
    if (!isOwnedDefinition(existing, definition.platform)) {
      throw new Error(`Refusing to remove a service definition not owned by Pinboard: ${definition.path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (definition.platform === "darwin") {
    const uid = process.getuid?.();
    if (uid !== undefined) {
      const target = `gui/${uid}/${definition.label}`;
      if (runner("launchctl", ["print", target]).status === 0) {
        requireSuccess(runner("launchctl", ["bootout", target]), "Could not unload the Pinboard launch agent");
      }
    }
  } else {
    if (runner("systemctl", ["--user", "is-enabled", "--quiet", definition.label]).status === 0
      || runner("systemctl", ["--user", "is-active", "--quiet", definition.label]).status === 0) {
      requireSuccess(runner("systemctl", ["--user", "disable", "--now", definition.label]), "Could not stop the Pinboard user service");
    }
  }
  await rm(definition.path);
  if (definition.platform === "linux") {
    requireSuccess(runner("systemctl", ["--user", "daemon-reload"]), `Removed ${definition.path}, but could not reload systemd user units`);
  }
  return true;
}

export function userServiceStatus(definition: ServiceDefinition, runner: CommandRunner = defaultRunner): {
  supported: boolean;
  installed: boolean;
  running: boolean;
  manager: "launchd" | "systemd" | "manual";
  path: string | null;
} {
  if (!definition.supported || !definition.path) {
    return { supported: false, installed: false, running: false, manager: "manual", path: null };
  }
  let installed = false;
  try {
    installed = isOwnedDefinition(readFileSync(definition.path, "utf8"), definition.platform);
  } catch {
    installed = false;
  }
  if (definition.platform === "darwin") {
    const uid = process.getuid?.();
    const status = uid === undefined ? null : runner("launchctl", ["print", `gui/${uid}/${definition.label}`]);
    const running = status?.status === 0 && /\bstate\s*=\s*running\b/iu.test(status.stdout);
    return { supported: true, installed, running, manager: "launchd", path: definition.path };
  }
  const running = runner("systemctl", ["--user", "is-active", "--quiet", definition.label]).status === 0;
  return { supported: true, installed, running, manager: "systemd", path: definition.path };
}

export function startUserService(definition: ServiceDefinition, runner: CommandRunner = defaultRunner): void {
  if (!definition.supported) throw new Error("No native Pinboard user service is available on this platform");
  if (definition.platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Cannot determine the macOS user ID for launchd");
    requireSuccess(runner("launchctl", ["kickstart", "-k", `gui/${uid}/${definition.label}`]), "Could not start the Pinboard launch agent");
  } else {
    requireSuccess(runner("systemctl", ["--user", "start", definition.label]), "Could not start the Pinboard user service");
  }
}

export function stopUserService(definition: ServiceDefinition, runner: CommandRunner = defaultRunner): void {
  if (!definition.supported) throw new Error("No native Pinboard user service is available on this platform");
  if (definition.platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Cannot determine the macOS user ID for launchd");
    requireSuccess(runner("launchctl", ["kill", "SIGTERM", `gui/${uid}/${definition.label}`]), "Could not stop the Pinboard launch agent");
  } else {
    requireSuccess(runner("systemctl", ["--user", "stop", definition.label]), "Could not stop the Pinboard user service");
  }
}
