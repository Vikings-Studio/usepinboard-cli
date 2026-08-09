#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import pc from "picocolors";
import { DaemonClient, DaemonClientError } from "./daemon/client.js";
import { daemonIsHealthy, startBackgroundDaemon, stopBackgroundDaemon } from "./daemon/lifecycle.js";
import { startDaemon } from "./daemon/server.js";
import { detectRepository } from "./domain/repository.js";
import type { DaemonStatus, LeaseRecord, LocalExportSnapshot, MessageRecord, Provider, SessionRecord, ThreadRecord } from "./domain/types.js";
import { configureProviderMcp, detectProviders } from "./integrations/detect.js";
import { handleProviderHook } from "./integrations/hook.js";
import { runMcpServer } from "./mcp/server.js";
import { ensureDirectories, getPaths, validatePurgeTarget } from "./platform/paths.js";
import { readOrCreateLocalSecret } from "./security/local-auth.js";
import { formatUntrusted } from "./security/untrusted.js";
import { heading, line, printJson, success, warning } from "./cli/output.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const VERSION = packageJson.version;

function numeric(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${value} is not a number`);
  return parsed;
}

function provider(value: string): Provider {
  if (["claude-code", "codex", "cli", "unknown"].includes(value)) return value as Provider;
  throw new Error(`Unsupported provider: ${value}`);
}

async function ensureStarted(): Promise<DaemonClient> {
  const paths = getPaths();
  if (!(await daemonIsHealthy(paths))) {
    await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard", paths });
  }
  return new DaemonClient(paths);
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
        providerConfiguration: options.configure ? "would configure detected providers" : "unchanged",
      });
      return;
    }
    await ensureDirectories(paths);
    await readOrCreateLocalSecret(paths);
    const pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard", paths });
    heading("Pinboard is ready locally");
    success(`Daemon running${pid ? ` (PID ${pid})` : ""}`);
    success(`Data directory: ${paths.dataDir}`);
    line();
    heading("Provider setup");
    for (const item of providers) {
      if (item.installed) {
        success(`${item.id}: ${item.version ?? "detected"}`);
        if (options.configure) {
          configureProviderMcp(item.id);
          success(`  Registered MCP server in ${item.id}`);
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
    const node = { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 24 };
    const healthy = await daemonIsHealthy(paths);
    const report = {
      node,
      daemon: { healthy, socket: paths.socket, dataDir: paths.dataDir },
      providers: detectProviders(),
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
          (item.mcpConfigured ? success : warning)(`  MCP: ${item.mcpConfigured ? "configured" : "not configured"}`);
          line(`  Hooks: ${item.hookSupport}; verify on the exact provider version before enabling injection.`);
        }
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
  const pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard" });
  success(`Daemon running${pid ? ` (PID ${pid})` : ""}`);
});
daemon.command("stop").action(async () => {
  const stopped = await stopBackgroundDaemon();
  (stopped ? success : warning)(stopped ? "Daemon stopped" : "Daemon was not running or did not stop cleanly");
});
daemon.command("restart").action(async () => {
  await stopBackgroundDaemon();
  const pid = await startBackgroundDaemon({ executable: process.argv[1] ?? "pinboard" });
  success(`Daemon restarted${pid ? ` (PID ${pid})` : ""}`);
});
daemon.command("status").action(async () => {
  line((await daemonIsHealthy()) ? "running" : "stopped");
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
    });
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
    const threads = await client.get<ThreadRecord[]>(`/v1/threads?${query.toString()}`);
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
    });
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
    await client.delete(`/v1/leases/${leaseId}?sessionId=${encodeURIComponent(options.session)}`);
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
  .argument("<event>")
  .requiredOption("--provider <provider>", "claude-code or codex", provider)
  .action(async (event: string, options: { provider: Provider }) => {
    await handleProviderHook(event, options.provider);
  });

program
  .command("debug-register", { hidden: true })
  .option("--provider <provider>", "provider", provider, "cli")
  .option("--task <label>")
  .action(async (options: { provider: Provider; task?: string }) => {
    const client = await ensureStarted();
    printJson(
      await client.post("/v1/sessions", {
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
    const client = await ensureStarted();
    const snapshot = await client.get<LocalExportSnapshot>("/v1/export");
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (options.output) {
      await writeFile(options.output, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      success(`Local data exported to ${options.output}`);
    } else {
      process.stdout.write(serialized);
    }
  });

program
  .command("purge")
  .description("Permanently delete local Pinboard state")
  .requiredOption("--confirm <phrase>", "must be exactly: delete-local-data")
  .action(async (options: { confirm: string }) => {
    if (options.confirm !== "delete-local-data") {
      throw new Error("Refusing to purge. Pass --confirm delete-local-data after exporting anything you need.");
    }
    const paths = getPaths();
    const target = validatePurgeTarget(paths.dataDir);
    await stopBackgroundDaemon(paths);
    await rm(target, { recursive: true, force: true });
    success(`Deleted local Pinboard data at ${target}. This cannot be recovered without an export.`);
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof DaemonClientError) {
    console.error(pc.red(`${error.code}: ${error.message}`));
  } else {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
  }
  process.exitCode = 1;
});
