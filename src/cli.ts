#!/usr/bin/env node
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import pc from "picocolors";
import { DaemonClient, DaemonClientError } from "./daemon/client.js";
import { daemonIsHealthy, startBackgroundDaemon, stopBackgroundDaemon } from "./daemon/lifecycle.js";
import { startDaemon } from "./daemon/server.js";
import { detectRepository } from "./domain/repository.js";
import type { DaemonStatus, LeaseRecord, LocalExportSnapshot, MessageRecord, Provider, SessionRecord, SessionRegistration, ThreadRecord } from "./domain/types.js";
import { configureProviderMcp, detectProviders, removeProviderMcp, type ProviderId } from "./integrations/detect.js";
import { installClaudeHooks, removeClaudeHooks } from "./integrations/claude-hooks.js";
import { handleProviderHook } from "./integrations/hook.js";
import { runMcpServer } from "./mcp/server.js";
import { ensureDirectories, getPaths, validatePurgeTarget } from "./platform/paths.js";
import {
  installUserService,
  removeUserService,
  restoreUserServiceManagerState,
  serviceDefinition,
  startUserService,
  stopUserService,
  userServiceStatus,
} from "./platform/service.js";
import { parseConfigKey, readConfig, setAuthConfig, setCloudConfig, setConfig } from "./config/settings.js";
import { runtimeSupported } from "./platform/runtime.js";
import { readOrCreateLocalSecret } from "./security/local-auth.js";
import { formatUntrusted, sanitizeUntrustedText, truncateUtf8 } from "./security/untrusted.js";
import { heading, line, printJson, success, warning } from "./cli/output.js";
import { readCloudCredential, removeCloudCredential, validateStaticToken, writeCloudCredential } from "./cloud/credentials.js";
import { normalizeCloudApiUrl, RelayClient } from "./cloud/client.js";
import { readRelayToken, deleteRelayToken } from "./cloud/token-reader.js";
import { applyCloudConnection } from "./cloud/activation.js";
import { deriveRepositoryId, isCloudIdentifier } from "./cloud/identifiers.js";
import { createCredentialStore } from "./auth/credential-store.js";
import { openBrowser } from "./auth/browser.js";
import { DEFAULT_API_URL, DEVICE_AUTH_ACCOUNT, DEVICE_AUTH_SERVICE } from "./constants.js";
import { currentPlatform, generateDeviceId, normalizeApiUrl, restoreDeviceCredential, runDeviceLogin } from "./auth/device-auth.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const VERSION = packageJson.version;

function numeric(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${value} is not a number`);
  return parsed;
}

async function readStaticTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("The token must be supplied on standard input, for example: `security find-generic-password ... -w | pinboard cloud connect --api https://...`");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += value.length;
    if (bytes > 8192) throw new Error("Cloud credential input is too large");
    chunks.push(value);
  }
  return validateStaticToken(Buffer.concat(chunks).toString("utf8"));
}

function provider(value: string): Provider {
  if (["claude-code", "codex", "cli", "unknown"].includes(value)) return value as Provider;
  throw new Error(`Unsupported provider: ${value}`);
}

function integrationProvider(value: string): ProviderId {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unsupported integration provider: ${value}`);
}

function sessionCapability(): string {
  const capability = process.env.PINBOARD_SESSION_CAPABILITY?.trim();
  if (!capability) {
    throw new Error("This session-scoped command requires PINBOARD_SESSION_CAPABILITY. Agent integrations set it internally.");
  }
  return capability;
}

function currentServiceDefinition() {
  const paths = getPaths();
  return serviceDefinition({
    nodeExecutable: process.execPath,
    cliExecutable: process.argv[1] ?? "",
    logPath: paths.log,
    ...(process.env.PINBOARD_HOME ? { pinboardHome: process.env.PINBOARD_HOME } : {}),
  });
}

async function configureIntegration(id: ProviderId, dryRun = false): Promise<void> {
  const providers = detectProviders();
  const detected = providers.find((item) => item.id === id);
  if (!detected?.installed) throw new Error(`${id} is not installed`);
  if (dryRun) {
    printJson({
      provider: id,
      mcp: detected.mcpVerified
        ? "unchanged"
        : detected.mcpConfigured
          ? detected.mcpOwned ? `reconcile Pinboard-owned entry with: ${detected.mcpCommand}` : "blocked: preserve conflicting named entry"
          : detected.mcpCommand,
      hooks: id === "claude-code"
        ? detected.hookSupport === "blocked-by-policy"
          ? "blocked by enterprise managed settings; MCP lifecycle only"
          : { path: `${process.env.HOME ?? "~"}/.claude/settings.json`, events: ["SessionStart", "UserPromptSubmit", "PostToolUse", "PreToolUse", "Stop", "SessionEnd"] }
        : "unsupported; MCP lifecycle only",
    });
    return;
  }
  const hadMcp = detected.mcpConfigured;
  configureProviderMcp(id);
  try {
    if (id === "claude-code" && detected.hookSupport !== "blocked-by-policy") {
      const result = await installClaudeHooks({ paths: getPaths() });
      success(result.changed ? `Installed Claude Code hooks in ${result.path}` : "Claude Code hooks already current");
      if (result.backup) line(`  Backup: ${result.backup}`);
    } else if (id === "claude-code") {
      warning("Claude user hooks are blocked by enterprise policy; configured MCP lifecycle only. Safe-point delivery and pre-edit lease context remain unavailable.");
    }
  } catch (error) {
    if (!hadMcp) removeProviderMcp(id, true);
    throw error;
  }
  success(`Configured ${id}`);
}

async function removeIntegration(id: ProviderId): Promise<void> {
  if (id === "claude-code") {
    const result = await removeClaudeHooks({ paths: getPaths() });
    if (result.changed) success(`Removed Pinboard-owned Claude hooks from ${result.path}`);
  }
  const mcp = removeProviderMcp(id);
  if (mcp === "preserved") warning(`Preserved non-Pinboard MCP entry named pinboard in ${id}`);
  else success(`Removed Pinboard-owned ${id} integration`);
}

async function ensureStarted(): Promise<DaemonClient> {
  const paths = getPaths();
  if (!(await daemonIsHealthy(paths))) {
    await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard", paths });
  }
  return new DaemonClient(paths);
}

async function waitForDaemonHealthy(paths = getPaths(), attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await daemonIsHealthy(paths)) return;
    await delay(100);
  }
  throw new Error(`Pinboard user service started but the daemon did not become healthy. See ${paths.log}`);
}

async function undoServiceInstallAfterHealthFailure(
  definition: ReturnType<typeof currentServiceDefinition>,
  installation: Awaited<ReturnType<typeof installUserService>> | null,
): Promise<void> {
  if (installation?.created) await removeUserService(definition);
  else if (installation?.changed && installation.previousContent) {
    await installUserService({ ...definition, content: installation.previousContent });
  }
  if (installation && !installation.created) restoreUserServiceManagerState(definition, installation.previousState);
}

async function recordHookFailure(error: unknown): Promise<void> {
  try {
    const paths = getPaths();
    await ensureDirectories(paths);
    const message = truncateUtf8(sanitizeUntrustedText(error instanceof Error ? error.message : String(error)), 2048);
    await appendFile(paths.log, `${new Date().toISOString()} [hook-failure] ${message}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Hook failures must remain non-blocking even when diagnostics cannot be written.
  }
}

async function recentHookFailure(path: string): Promise<string | null> {
  try {
    const lines = (await readFile(path, "utf8")).split("\n").filter((entry) => entry.includes("[hook-failure]"));
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function exportLocalData(output?: string): Promise<void> {
  const client = await ensureStarted();
  const snapshot = await client.get<LocalExportSnapshot>("/v1/export");
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (output) {
    await writeFile(output, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    success(`Local data exported to ${output}`);
  } else {
    process.stdout.write(serialized);
  }
}

async function purgeLocalData(confirm: string): Promise<void> {
  if (confirm !== "delete-local-data") {
    throw new Error("Refusing to purge. Pass --confirm delete-local-data after exporting anything you need.");
  }
  const paths = getPaths();
  const target = await validatePurgeTarget(paths.dataDir);
  const definition = currentServiceDefinition();
  if (userServiceStatus(definition).installed) await removeUserService(definition);
  await stopBackgroundDaemon(paths);
  if (await daemonIsHealthy(paths)) {
    throw new Error(`Refusing to purge while the Pinboard daemon is still running. Stop it and retry; data remains at ${target}.`);
  }
  await rm(target, { recursive: true, force: true });
  success(`Deleted local Pinboard data at ${target}. This cannot be recovered without an export.`);
}

function printPresence(sessions: SessionRecord[]): void {
  if (sessions.length === 0) {
    line("No active sessions found.");
    return;
  }
  for (const session of sessions) {
    line(`${pc.cyan(session.address)}  ${session.state}  ${session.lastActiveAt}`);
    line(`  ${session.repositoryName}#${session.branch}${session.taskLabel ? ` — ${session.taskLabel}` : ""}`);
  }
}

const program = new Command();
program.name("pinboard").description("Local-first communication for coding agents").version(VERSION);

program
  .command("init")
  .description("Initialize the local daemon and show provider setup")
  .option("--dry-run", "show changes without writing or starting the daemon")
  .option("--configure", "explicitly register Pinboard MCP with every detected provider")
  .action(async (options: { dryRun?: boolean; configure?: boolean }) => {
    const paths = getPaths();
    const providers = detectProviders();
    if (options.dryRun) {
      printJson({
        writes: [paths.dataDir, paths.database, paths.secret, paths.pid, paths.log],
        socket: paths.socket,
        providers,
        providerConfiguration: options.configure
          ? providers.filter((item) => item.installed).map((item) => ({
            provider: item.id,
            mcp: item.mcpVerified ? "unchanged" : item.mcpConfigured ? item.mcpOwned ? "reconcile Pinboard-owned entry" : "blocked by conflicting named entry" : "add",
            hooks: item.id === "claude-code" ? item.hookSupport : "MCP lifecycle only",
          }))
          : "unchanged",
        service: currentServiceDefinition(),
      });
      return;
    }
    await ensureDirectories(paths);
    await readOrCreateLocalSecret(paths);
    const definition = currentServiceDefinition();
    let pid = 0;
    if (definition.supported && (process.argv[1] ?? "").endsWith(".js")) {
      await stopBackgroundDaemon(paths).catch(() => false);
      let serviceInstall: Awaited<ReturnType<typeof installUserService>> | null = null;
      try {
        const installed = await installUserService(definition);
        serviceInstall = installed;
        await waitForDaemonHealthy(paths);
        success(`${definition.platform === "darwin" ? "launchd" : "systemd"} user service ${installed.changed ? "installed" : "already current"}`);
      } catch (error) {
        try {
          await undoServiceInstallAfterHealthFailure(definition, serviceInstall);
        } catch (rollbackError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nCould not restore the previous user service: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        warning(`Native user service unavailable: ${error instanceof Error ? error.message : String(error)}`);
        pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard", paths });
        warning("Started the authenticated detached daemon fallback; it will not restart automatically after logout or reboot");
      }
    } else {
      pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard", paths });
      warning(definition.supported
        ? "Source-mode execution cannot install a durable service; started a detached daemon"
        : "Native service installation is unavailable on this platform; started a detached daemon (Windows is beta)");
    }
    heading("Pinboard is ready locally");
    success(`Daemon running${pid ? ` (PID ${pid})` : ""}`);
    success(`Data directory: ${paths.dataDir}`);
    line();
    heading("Provider setup");
    for (const item of providers) {
      if (item.installed) {
        success(`${item.id}: ${item.version ?? "detected"}`);
        if (options.configure) {
          await configureIntegration(item.id);
        } else {
          line(`  ${item.mcpCommand}`);
        }
      } else {
        warning(`${item.id}: not detected`);
      }
    }
    line();
    line(options.configure
      ? "Provider configuration was requested explicitly. Run `pinboard doctor`."
      : "Pinboard does not edit provider configuration silently. Run the shown MCP command or re-run `pinboard init --configure`, then `pinboard doctor`.");
  });

program
  .command("doctor")
  .description("Diagnose the local daemon and provider capabilities")
  .option("--json", "print machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const paths = getPaths();
    const node = { version: process.version, supported: runtimeSupported() };
    const healthy = await daemonIsHealthy(paths);
    const report = {
      node,
      daemon: { healthy, socket: paths.socket, dataDir: paths.dataDir },
      providers: detectProviders(),
      service: userServiceStatus(currentServiceDefinition()),
      hooks: { recentFailure: await recentHookFailure(paths.log) },
      privacy: { telemetry: false, cloudConnected: false },
    };
    if (options.json) printJson(report);
    else {
      heading("Pinboard doctor");
      (node.supported ? success : warning)(`Node ${node.version}${node.supported ? "" : " (Node 24.15+ required)"}`);
      (healthy ? success : warning)(`Daemon ${healthy ? "healthy" : "not running"}`);
      for (const item of report.providers) {
        (item.installed ? success : warning)(`${item.id}: ${item.version ?? "not detected"}`);
        if (item.installed) {
          (item.mcpVerified ? success : warning)(`  MCP: ${item.mcpVerified ? "verified" : item.mcpConfigured ? "named entry differs" : "not configured"}`);
          line(`  Presence: ${item.capabilities.presence}`);
          line(`  Safe-point delivery: ${item.capabilities.safePointDelivery ? "configured" : "unavailable"}`);
          if (item.capabilities.safePointDelivery) line("  Exact-version hook runtime: canary required");
          line("  Wake/resume: unsupported");
        }
      }
      if (report.hooks.recentFailure) {
        warning(`Recent provider hook failure (historical until the next successful canary): ${report.hooks.recentFailure}`);
      }
    }
    if (!node.supported || !healthy) process.exitCode = 1;
  });

program
  .command("status")
  .description("Show daemon and active-session status")
  .option("--json", "print machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const client = await ensureStarted();
    const status = await client.get<DaemonStatus>("/v1/status");
    const sessions = await client.get<SessionRecord[]>("/v1/presence?includeIdle=true");
    if (options.json) printJson({ status, sessions });
    else {
      heading("Pinboard local status");
      line(`Daemon uptime: ${status.uptimeSeconds}s`);
      line(`Sessions: ${status.sessions.active} active, ${status.sessions.idle} idle, ${status.sessions.stale} stale`);
      line(`Unread messages: ${status.unreadMessages}`);
      line(`Active leases: ${status.activeLeases}`);
      line();
      printPresence(sessions);
    }
  });

const daemon = program.command("daemon").description("Manage the local daemon");
daemon.command("start").action(async () => {
  const definition = currentServiceDefinition();
  const serviceStatus = userServiceStatus(definition);
  if (serviceStatus.installed) {
    startUserService(definition);
    success(`Daemon running through ${serviceStatus.manager}`);
  } else {
    const pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard" });
    success(`Daemon running${pid ? ` (PID ${pid})` : ""}`);
  }
});
daemon.command("stop").action(async () => {
  const definition = currentServiceDefinition();
  const serviceStatus = userServiceStatus(definition);
  if (serviceStatus.installed) {
    stopUserService(definition);
    success(`Daemon stopped through ${serviceStatus.manager}`);
  } else {
    const stopped = await stopBackgroundDaemon();
    (stopped ? success : warning)(stopped ? "Daemon stopped" : "Daemon was not running or did not stop cleanly");
  }
});
daemon.command("restart").action(async () => {
  const definition = currentServiceDefinition();
  const serviceStatus = userServiceStatus(definition);
  if (serviceStatus.installed) {
    stopUserService(definition);
    startUserService(definition);
    success(`Daemon restarted through ${serviceStatus.manager}`);
  } else {
    await stopBackgroundDaemon();
    const pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard" });
    success(`Daemon restarted${pid ? ` (PID ${pid})` : ""}`);
  }
});
daemon.command("status").action(async () => {
  const status = userServiceStatus(currentServiceDefinition());
  line(`${(await daemonIsHealthy()) ? "running" : "stopped"}${status.installed ? ` via ${status.manager}` : " manually"}`);
});
daemon.command("logs").action(async () => {
  const paths = getPaths();
  heading(paths.log);
  try {
    const contents = await readFile(paths.log, "utf8");
    line(contents.split("\n").slice(-100).join("\n"));
  } catch {
    warning("No daemon log exists yet");
  }
});
daemon
  .command("run", { hidden: true })
  .action(async () => {
    const handle = await startDaemon({ version: VERSION, foreground: true });
    const shutdown = () => void handle.close().finally(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise(() => undefined);
  });

const service = program.command("service").description("Manage the platform user service");
service.command("install").option("--dry-run").action(async (options: { dryRun?: boolean }) => {
  const definition = currentServiceDefinition();
  if (options.dryRun) {
    printJson(definition);
    return;
  }
  await ensureDirectories(getPaths());
  let serviceInstall: Awaited<ReturnType<typeof installUserService>> | null = null;
  try {
    const result = await installUserService(definition);
    serviceInstall = result;
    await waitForDaemonHealthy(getPaths());
    success(`User service ${result.changed ? "installed" : "already current"}: ${result.path}`);
  } catch (error) {
    try {
      await undoServiceInstallAfterHealthFailure(definition, serviceInstall);
    } catch (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nCould not restore the previous user service: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
});
service.command("uninstall").action(async () => {
  const removed = await removeUserService(currentServiceDefinition());
  (removed ? success : warning)(removed ? "Pinboard user service removed" : "No Pinboard-owned user service found");
});
service.command("start").action(() => {
  startUserService(currentServiceDefinition());
  success("Pinboard user service started");
});
service.command("stop").action(() => {
  stopUserService(currentServiceDefinition());
  success("Pinboard user service stopped");
});
service.command("restart").action(() => {
  const definition = currentServiceDefinition();
  stopUserService(definition);
  startUserService(definition);
  success("Pinboard user service restarted");
});
service.command("status").option("--json").action((options: { json?: boolean }) => {
  const status = userServiceStatus(currentServiceDefinition());
  if (options.json) printJson(status);
  else line(`${status.manager}: ${status.installed ? "installed" : "not installed"}, ${status.running ? "running" : "stopped"}`);
  if (status.supported && (!status.installed || !status.running)) process.exitCode = 1;
});

const integrations = program.command("integrations").description("Manage coding-provider integrations");
integrations.command("list").option("--json").action((options: { json?: boolean }) => {
  const detected = detectProviders();
  if (options.json) printJson(detected);
  else for (const item of detected) {
    line(`${item.id}: ${item.installed ? item.version ?? "detected" : "not installed"}; MCP ${item.mcpVerified ? "verified" : item.mcpConfigured ? "named entry differs" : "not configured"}; ${item.hookSupport}`);
  }
});
integrations
  .command("install")
  .argument("[provider]", "claude-code or codex", integrationProvider)
  .option("--dry-run")
  .action(async (selected: ProviderId | undefined, options: { dryRun?: boolean }) => {
    const ids: ProviderId[] = selected ? [selected] : detectProviders().filter((item) => item.installed).map((item) => item.id);
    if (ids.length === 0) throw new Error("No supported provider is installed");
    for (const id of ids) await configureIntegration(id, options.dryRun);
  });
integrations
  .command("remove")
  .argument("[provider]", "claude-code or codex", integrationProvider)
  .action(async (selected: ProviderId | undefined) => {
    const ids: ProviderId[] = selected ? [selected] : ["claude-code", "codex"];
    for (const id of ids) await removeIntegration(id);
  });
integrations.command("doctor").option("--json").action((options: { json?: boolean }) => {
  const detected = detectProviders();
  const report = detected.map((item) => ({
    ...item,
    status: !item.installed || !item.mcpVerified || (item.id === "claude-code" && !item.capabilities.safePointDelivery)
      ? "incomplete" as const
      : Object.values(item.capabilityMatrix).filter((capability) => capability.configured).every((capability) => capability.runtimeVerified)
        ? "verified" as const
        : "configured-unverified" as const,
  }));
  if (options.json) printJson(report);
  else for (const item of report) (item.status === "verified" ? success : warning)(`${item.id}: ${item.status}`);
  if (report.some((item) => item.installed && item.status === "incomplete")) process.exitCode = 1;
});

const config = program.command("config").description("Read or update local Pinboard settings");
config.command("path").action(() => line(getPaths().config));
config.command("get").argument("[key]", "idleMinutes or staleMinutes", parseConfigKey).action(async (key?: ReturnType<typeof parseConfigKey>) => {
  const current = await readConfig(getPaths());
  if (key) line(String(current[key]));
  else printJson(current);
});
config.command("set").argument("<key>", "idleMinutes or staleMinutes", parseConfigKey).argument("<value>").action(async (key: ReturnType<typeof parseConfigKey>, value: string) => {
  const next = await setConfig(getPaths(), key, value);
  success(`${key}=${String(next[key])}; restart Pinboard to apply the change`);
});

const cloud = program.command("cloud").description("Connect to the Pinboard Cloud relay (legacy static-token flow)");
cloud
  .command("connect")
  .requiredOption("--api <url>", "relay base URL")
  .description("Connect using a static token read only from stdin (legacy)")
  .action(async (options: { api: string }) => {
    if (process.platform === "win32") throw new Error("Cloud relay connection is unavailable on Windows until OS credential protection is implemented; Personal remains supported");
    const paths = getPaths();
    const token = await readStaticTokenFromStdin();
    const apiUrl = normalizeCloudApiUrl(options.api);
    const current = await readConfig(paths);
    const previousToken = current.cloud.enabled ? await readCloudCredential(paths).catch(() => null) : null;
    const relay = new RelayClient(apiUrl, token);
    const bootstrap = await relay.bootstrap();
    const nextCloud = {
      enabled: true,
      apiUrl,
      organizationId: bootstrap.organizationId,
      userId: bootstrap.userId,
      deviceId: bootstrap.deviceId,
      syncPaused: false,
    };
    await ensureDirectories(paths);
    const client = await ensureStarted();
    try {
      await writeCloudCredential(paths, token);
      await applyCloudConnection({
        paths,
        nextCloud,
        previousCloud: current.cloud,
        notify: async (cloud) => { await client.post("/v1/cloud/connection", { ...cloud }); },
      });
    } catch (error) {
      if (previousToken) await writeCloudCredential(paths, previousToken).catch(() => undefined);
      else await removeCloudCredential(paths).catch(() => undefined);
      throw error;
    }
    success(`Organization ${bootstrap.organizationId}; ${bootstrap.repositoryIds.length} allowed repositories`);
    line("Link a repository with `pinboard repo link` and run `pinboard sync now`.");
  });
cloud.command("status").option("--json").action(async (options: { json?: boolean }) => {
  const client = await ensureStarted();
  const status = await client.get<Record<string, unknown>>("/v1/cloud/status");
  if (options.json) printJson(status);
  else {
    const config = status.config as Record<string, unknown> | undefined;
    const queue = status.queue as Record<string, unknown> | undefined;
    heading("Pinboard Cloud relay");
    line(config?.enabled ? `Connected to ${String(config.apiUrl)} as organization ${String(config.organizationId)}` : "Not connected");
    if (queue) {
      const outboxDead = typeof queue.outboxDead === "number" ? queue.outboxDead : 0;
      const receiptsDead = typeof queue.receiptsDead === "number" ? queue.receiptsDead : 0;
      line(`Pending: ${String(queue.outboxPending)} messages, ${String(queue.receiptsPending)} receipts; inbox ${String(queue.inboxQueued)}; dead-letter ${String(outboxDead)} messages/${String(receiptsDead)} receipts`);
    }
  }
});
cloud
  .command("disconnect")
  .option("--discard-pending", "permanently discard unsent messages and receipts")
  .action(async (options: { discardPending?: boolean }) => {
    const paths = getPaths();
    const client = await ensureStarted();
    const status = await client.get<{ queue: { outboxPending: number; receiptsPending: number } | null }>("/v1/cloud/status");
    if (!options.discardPending && status.queue && (status.queue.outboxPending > 0 || status.queue.receiptsPending > 0)) {
      throw new Error("Cloud work is pending; run `pinboard sync now` or pass --discard-pending explicitly");
    }
    const ended = await client.post<{ ended: number; failed: number }>("/v1/cloud/end-sessions").catch(() => ({ ended: 0, failed: 1 }));
    if (ended.failed > 0) warning(`${ended.failed} remote session cleanup request${ended.failed === 1 ? "" : "s"} failed; relay presence will remain until its server-side expiry.`);
    await client.delete(`/v1/cloud/connection?discardPending=${String(options.discardPending === true)}`);
    const current = await readConfig(paths);
    await setCloudConfig(paths, { ...current.cloud, enabled: false, syncPaused: false });
    await deleteRelayToken(paths);
    success("Disconnected the Cloud relay. Personal data and local messaging were preserved.");
  });

const auth = program.command("auth").description("Authenticate this device with Pinboard Cloud using the device authorization flow");
auth
  .command("login")
  .description("Start a device authorization and store the access token in the OS credential store")
  .option("--api <url>", `Pinboard API base URL (default: ${DEFAULT_API_URL})`)
  .option("--no-browser", "print the verification URL instead of opening the browser")
  .action(async (options: { api?: string; browser: boolean }) => {
    const paths = getPaths();
    if (options.api !== undefined && options.api.length === 0) throw new Error("--api must be a non-empty https URL");
    const apiUrl = normalizeApiUrl(options.api ?? DEFAULT_API_URL);
    const config = await readConfig(paths);
    const deviceId = config.auth.deviceId ?? generateDeviceId();
    const credentialStore = createCredentialStore();
    // Preserve any previously stored OS token before the device
    // authorization flow overwrites it; a failed local cloud activation
    // must restore the prior token instead of stranding the old session.
    const previousToken = await credentialStore.read(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT).catch(() => null);
    const result = await runDeviceLogin({
      apiUrl,
      deviceId,
      deviceName: "pinboard-cli",
      platform: currentPlatform(),
      credentialStore,
      ...(options.browser ? { openBrowser } : {}),
      onShow: (verificationUrl, userCode) => {
        heading("Pinboard device authorization");
        line(`Open this URL in a browser and enter the code:`);
        line();
        line(`  ${pc.cyan(verificationUrl)}`);
        line();
        line(`Your code: ${pc.bold(userCode)}`);
        line();
        line("Waiting for approval…");
      },
    });
    await ensureDirectories(paths);
    const previousCloud = config.cloud;
    const previousAuth = config.auth;
    const nextCloud = {
      enabled: true,
      apiUrl,
      organizationId: result.organizationId,
      userId: result.userId,
      deviceId: result.deviceId,
      syncPaused: false,
    };
    try {
      await setAuthConfig(paths, { deviceId: result.deviceId });
      await applyCloudConnection({
        paths,
        nextCloud,
        previousCloud,
        notify: async (cloud) => {
          const client = await ensureStarted();
          await client.post("/v1/cloud/connection", { ...cloud });
        },
      });
    } catch (error) {
      await setAuthConfig(paths, previousAuth).catch(() => undefined);
      await restoreDeviceCredential(credentialStore, previousToken).catch(() => undefined);
      throw error;
    }
    success(`Authenticated as organization ${result.organizationId}, user ${result.userId}`);
    line(`Device ${result.deviceId} is authorized`);
  });
auth
  .command("status")
  .description("Show whether this device has a stored access token")
  .option("--json", "print machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const paths = getPaths();
    const config = await readConfig(paths);
    let token: string | null = null;
    let error: string | null = null;
    try {
      token = await createCredentialStore().read(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const report = {
      authenticated: token !== null,
      deviceId: config.auth.deviceId,
      credentialStore: error ? { error } : { available: true },
    };
    if (options.json) printJson(report);
    else if (token) success(`Authenticated${config.auth.deviceId ? ` as device ${config.auth.deviceId}` : ""}`);
    else if (error) warning(`Not authenticated. Credential store unavailable: ${error}`);
    else line("Not authenticated. Run `pinboard auth login`.");
  });
auth
  .command("logout")
  .description("Disconnect Cloud relay and remove the stored access token")
  .action(async () => {
    const paths = getPaths();
    const client = await ensureStarted().catch(() => null);
    if (client) {
      try { await client.delete("/v1/cloud/connection?discardPending=true"); } catch { /* best-effort */ }
    }
    const current = await readConfig(paths);
    if (current.cloud.enabled) {
      await setCloudConfig(paths, { ...current.cloud, enabled: false, syncPaused: false });
    }
    await deleteRelayToken(paths);
    success("Disconnected Cloud relay and removed the stored access token. Server-side revocation is not performed by this command.");
  });

const sync = program.command("sync").description("Synchronize the Cloud relay once or control synchronization");
sync.command("now").option("--json").action(async (options: { json?: boolean }) => {
  const client = await ensureStarted();
  const result = await client.post<Record<string, unknown>>("/v1/cloud/sync");
  if (options.json) printJson(result);
  else {
    const failures = Number(result.sessionsFailed ?? 0) + Number(result.messagesFailed ?? 0) + Number(result.receiptsFailed ?? 0);
    (failures > 0 ? warning : success)(`Sync complete: ${String(result.sessionsPushed)} active, ${String(result.sessionsEnded)} ended, ${String(result.messagesSent)} sent, ${String(result.messagesReceived)} received, ${String(result.receiptsSent)} receipts${failures ? `, ${String(failures)} deferred` : ""}`);
  }
});
sync.command("status").option("--json").action(async (options: { json?: boolean }) => {
  const client = await ensureStarted();
  const status = await client.get<Record<string, unknown>>("/v1/cloud/status");
  if (options.json) printJson(status);
  else printJson({ config: status.config, queue: status.queue });
});
for (const paused of [true, false]) {
  sync.command(paused ? "pause" : "resume").action(async () => {
    const paths = getPaths();
    const current = await readConfig(paths);
    if (!current.cloud.enabled) throw new Error("Pinboard Cloud is not connected");
    await setCloudConfig(paths, { ...current.cloud, syncPaused: paused });
    success(`Cloud sync ${paused ? "paused" : "resumed"}; Personal remains fully available.`);
  });
}

const repo = program.command("repo").description("Manage Cloud repository links");
repo
  .command("link")
  .argument("[path]", "repository path", process.cwd())
  .option("--repository-id <id>", "override the derived repository ID")
  .action(async (path: string, options: { repositoryId?: string }) => {
    const paths = getPaths();
    const config = await readConfig(paths);
    if (!config.cloud.enabled || !config.cloud.organizationId || !config.cloud.apiUrl) throw new Error("Pinboard Cloud is not connected");
    const repository = detectRepository(path);
    if (repository.identity.startsWith("local:")) throw new Error("A repository with a normalized Git remote is required for Cloud relay");
    let repositoryId: string;
    if (options.repositoryId) {
      if (!isCloudIdentifier(options.repositoryId)) throw new Error("--repository-id must be a stable 1-128 character identifier");
      repositoryId = options.repositoryId;
    } else {
      repositoryId = deriveRepositoryId(repository.identity);
    }
    const relay = new RelayClient(config.cloud.apiUrl, await readRelayToken(paths));
    await relay.linkRepository(repositoryId, repository.identity, repository.name);
    const client = await ensureStarted();
    await client.post("/v1/cloud/repositories", {
      organizationId: config.cloud.organizationId,
      repositoryId,
      repositoryIdentity: repository.identity,
      repositoryName: repository.name,
    });
    success(`Linked ${repository.identity} to ${repositoryId}`);
  });
repo.command("list").option("--json").action(async (options: { json?: boolean }) => {
  const links = await (await ensureStarted()).get<Array<Record<string, unknown>>>("/v1/cloud/repositories");
  if (options.json) printJson(links);
  else if (links.length === 0) line("No Cloud repositories linked.");
  else for (const link of links) line(`${String(link.repositoryId)}  ${String(link.repositoryIdentity)}`);
});
repo.command("status").argument("[path]", "repository path", process.cwd()).option("--json").action(async (path: string, options: { json?: boolean }) => {
  const repository = detectRepository(path);
  const links = await (await ensureStarted()).get<Array<Record<string, unknown>>>("/v1/cloud/repositories");
  const link = links.find((item) => item.repositoryIdentity === repository.identity) ?? null;
  if (options.json) printJson({ repository, link });
  else line(link ? `Linked to ${String(link.repositoryId)}` : "This repository is not linked to Cloud.");
});
repo.command("unlink").argument("<id-or-identity>").action(async (selector: string) => {
  await (await ensureStarted()).delete(`/v1/cloud/repositories/${encodeURIComponent(selector)}`);
  success(`Unlinked ${selector}`);
});

const session = program.command("session").description("Manage one local agent session");
session
  .command("end")
  .requiredOption("--id <session-id>")
  .action(async (options: { id: string }) => {
    const client = await ensureStarted();
    await client.post(`/v1/sessions/${options.id}/end`, {}, sessionCapability());
    success(`Session ${options.id} ended`);
  });

program
  .command("who")
  .description("List active coding-agent sessions")
  .option("--repo <identity>")
  .option("--branch <branch>")
  .option("--include-idle", "include idle sessions", true)
  .option("--json")
  .action(async (options: { repo?: string; branch?: string; includeIdle: boolean; json?: boolean }) => {
    const client = await ensureStarted();
    const query = new URLSearchParams({ includeIdle: String(options.includeIdle) });
    if (options.repo) query.set("repo", options.repo);
    if (options.branch) query.set("branch", options.branch);
    const sessions = await client.get<SessionRecord[]>(`/v1/presence?${query.toString()}`);
    if (options.json) printJson(sessions);
    else printPresence(sessions);
  });

program
  .command("send")
  .description("Send a targeted local message")
  .argument("<to>", "Pinboard address or session ID")
  .argument("<message>", "message body")
  .option("--from-session <id>")
  .option("--thread <id>")
  .option("--idempotency-key <uuid>", "reuse a stable key when retrying a send")
  .option("--json")
  .action(async (to: string, message: string, options: { fromSession?: string; thread?: string; idempotencyKey?: string; json?: boolean }) => {
    const client = await ensureStarted();
    const sent = await client.post("/v1/messages", {
      to,
      body: message,
      ...(options.fromSession ? { senderSessionId: options.fromSession } : {}),
      ...(options.thread ? { threadId: options.thread } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    }, options.fromSession ? sessionCapability() : undefined);
    if (options.json) printJson(sent);
    else success(`Message queued for ${to}`);
  });

program
  .command("inbox")
  .description("Read a specific session inbox")
  .requiredOption("--session <id>", "recipient session ID")
  .option("--unread-only", "return only unread messages", true)
  .option("--limit <n>", "maximum messages", numeric, 20)
  .option("--json")
  .action(async (options: { session: string; unreadOnly: boolean; limit: number; json?: boolean }) => {
    const client = await ensureStarted();
    const messages = await client.get<MessageRecord[]>(
      `/v1/inbox?sessionId=${encodeURIComponent(options.session)}&unreadOnly=${String(options.unreadOnly)}&limit=${String(options.limit)}`,
      sessionCapability(),
    );
    if (options.json) printJson(messages);
    else {
      if (messages.length === 0) line("Inbox is empty.");
      for (const message of messages) {
        heading(`Message ${message.id} · ${message.createdAt}`);
        line(formatUntrusted({ kind: "message", sender: message.senderAddress, body: message.body }));
        line();
      }
    }
  });

program
  .command("threads")
  .description("List durable local conversation history")
  .option("--session <id>", "limit history to one session")
  .option("--limit <n>", "maximum threads", numeric, 20)
  .option("--json")
  .action(async (options: { session?: string; limit: number; json?: boolean }) => {
    const client = await ensureStarted();
    const query = new URLSearchParams({ limit: String(options.limit) });
    if (options.session) query.set("sessionId", options.session);
    const threads = await client.get<ThreadRecord[]>(
      `/v1/threads?${query.toString()}`,
      options.session ? sessionCapability() : undefined,
    );
    if (options.json) printJson(threads);
    else if (threads.length === 0) line("No conversation history yet.");
    else {
      for (const thread of threads) {
        heading(`${thread.id} · ${thread.messageCount} message${thread.messageCount === 1 ? "" : "s"}`);
        line(`  ${thread.participants.join(" ↔ ")}`);
        line(`  Last activity: ${thread.lastMessageAt}${thread.unreadCount ? ` · ${thread.unreadCount} unread` : ""}`);
      }
    }
  });

program
  .command("reserve")
  .description("Create an advisory file lease")
  .argument("<paths...>", "path globs")
  .requiredOption("--session <id>", "owner session ID")
  .requiredOption("--ttl <minutes>", "lease TTL", numeric)
  .option("--note <text>")
  .option("--json")
  .action(async (paths: string[], options: { session: string; ttl: number; note?: string; json?: boolean }) => {
    const client = await ensureStarted();
    const lease = await client.post<LeaseRecord>("/v1/leases", {
      sessionId: options.session,
      paths,
      ttlMinutes: options.ttl,
      ...(options.note ? { note: options.note } : {}),
    }, sessionCapability());
    if (options.json) printJson(lease);
    else success(`Lease ${lease.id} active until ${lease.expiresAt}`);
  });

program
  .command("release")
  .description("Release an advisory lease")
  .argument("<lease-id>")
  .requiredOption("--session <id>", "owner session ID")
  .action(async (leaseId: string, options: { session: string }) => {
    const client = await ensureStarted();
    await client.delete(`/v1/leases/${leaseId}?sessionId=${encodeURIComponent(options.session)}`, sessionCapability());
    success(`Lease ${leaseId} released`);
  });

program
  .command("mcp")
  .description("Run the Pinboard MCP server over stdio")
  .requiredOption("--provider <provider>", "claude-code or codex", provider)
  .option("--session-id <id>")
  .option("--task <label>")
  .action(async (options: { provider: Provider; sessionId?: string; task?: string }) => {
    await runMcpServer({
      provider: options.provider,
      version: VERSION,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.task ? { taskLabel: options.task } : {}),
    });
  });

program
  .command("hook")
  .description("Handle a provider hook event from JSON stdin")
  .argument("<provider>", "claude-code or codex", provider)
  .action(async (hookProvider: Provider) => {
    try {
      const output = await handleProviderHook(hookProvider);
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      // Provider hooks fail open: Pinboard must never break a coding session.
      await recordHookFailure(error);
    }
  });

program
  .command("debug-register", { hidden: true })
  .option("--provider <provider>", "provider", provider, "cli")
  .option("--task <label>")
  .action(async (options: { provider: Provider; task?: string }) => {
    const client = await ensureStarted();
    printJson(
      await client.post<SessionRegistration>("/v1/sessions", {
        id: randomUUID(),
        provider: options.provider,
        repository: detectRepository(),
        ...(options.task ? { taskLabel: options.task } : {}),
        pid: process.pid,
      }),
    );
  });

program
  .command("logs")
  .description("Print the daemon log path and recent content")
  .action(async () => {
    const paths = getPaths();
    heading(paths.log);
    try {
      const contents = await readFile(paths.log, "utf8");
      line(contents.split("\n").slice(-100).join("\n"));
    } catch {
      warning("No daemon log exists yet");
    }
  });

program
  .command("export")
  .description("Export all local Pinboard data as versioned JSON")
  .option("--output <path>", "write to a file instead of standard output")
  .action(async (options: { output?: string }) => {
    await exportLocalData(options.output);
  });

program
  .command("purge")
  .description("Permanently delete local Pinboard state")
  .requiredOption("--confirm <phrase>", "must be exactly: delete-local-data")
  .action(async (options: { confirm: string }) => {
    await purgeLocalData(options.confirm);
  });

const data = program.command("data").description("Export or permanently purge local Pinboard data");
data.command("export").option("--output <path>").action(async (options: { output?: string }) => exportLocalData(options.output));
data.command("purge").requiredOption("--confirm <phrase>").action(async (options: { confirm: string }) => purgeLocalData(options.confirm));

program
  .command("update")
  .description("Update the global Pinboard CLI package through npm")
  .option("--dry-run", "print the exact package-manager command")
  .action((options: { dryRun?: boolean }) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = ["install", "-g", "@usepinboard/cli@latest"];
    if (options.dryRun) {
      line(`${command} ${args.join(" ")}`);
      return;
    }
    if (VERSION.includes("development")) {
      throw new Error("The public npm package is not published yet. Use `pinboard update --dry-run` to preview the future command.");
    }
    const result = spawnSync(command, args, { encoding: "utf8", shell: false, stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `npm exited with status ${String(result.status)}`);
    success("Pinboard CLI updated. Run `pinboard init --configure` to reconcile the service and provider integrations.");
  });

program
  .command("uninstall")
  .description("Remove Pinboard-owned services and provider integrations; preserve local data by default")
  .option("--purge-data", "also permanently delete local Pinboard data")
  .option("--confirm <phrase>", "required with --purge-data: delete-local-data")
  .action(async (options: { purgeData?: boolean; confirm?: string }) => {
    if (options.purgeData && options.confirm !== "delete-local-data") {
      throw new Error("Refusing to purge data. Pass --purge-data --confirm delete-local-data.");
    }
    for (const id of ["claude-code", "codex"] as const) await removeIntegration(id);
    await removeUserService(currentServiceDefinition());
    await stopBackgroundDaemon().catch(() => false);
    if (options.purgeData) {
      const target = await validatePurgeTarget(getPaths().dataDir);
      if (await daemonIsHealthy(getPaths())) {
        throw new Error(`Refusing to purge while the Pinboard daemon is still running. Data remains at ${target}.`);
      }
      await rm(target, { recursive: true, force: true });
      success(`Removed Pinboard and permanently deleted ${target}`);
    } else {
      success(`Removed Pinboard-owned integrations and service. Local data is preserved at ${getPaths().dataDir}`);
      line("Remove the npm package separately with `npm uninstall -g @usepinboard/cli` when ready.");
    }
  });

const execution = runtimeSupported()
  ? program.parseAsync()
  : Promise.reject(new Error(`Pinboard requires Node.js 24.15.0 or newer; found ${process.version}`));

execution.catch((error: unknown) => {
  if (error instanceof DaemonClientError) {
    console.error(pc.red(`${error.code}: ${error.message}`));
  } else {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
  }
  process.exitCode = 1;
});
