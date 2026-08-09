import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
const pinboardHome = await mkdtemp(join(tmpdir(), "pinboard-acceptance-"));
const environment = { ...process.env, PINBOARD_HOME: pinboardHome, NO_COLOR: "1" };

function run(args, cwd = root) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runJson(args, cwd = root) {
  return JSON.parse(run(args, cwd));
}

const daemon = spawn(process.execPath, [cli, "daemon", "run"], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
let daemonError = "";
daemon.stderr.on("data", (chunk) => {
  daemonError += chunk.toString();
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const status = runJson(["status", "--json"]);
      if (status.status?.version) {
        ready = true;
        break;
      }
    } catch {
      // The daemon may still be binding its socket.
    }
    await delay(100);
  }
  if (!ready) throw new Error(`Daemon did not become healthy: ${daemonError}`);

  const claude = runJson(["debug-register", "--provider", "claude-code", "--task", "billing"]);
  const codex = runJson(["debug-register", "--provider", "codex", "--task", "checkout"]);
  const presence = runJson(["who", "--include-idle", "--json"]);
  if (!presence.some((session) => session.id === claude.id) || !presence.some((session) => session.id === codex.id)) {
    throw new Error("Two-session presence discovery failed");
  }

  const idempotencyKey = randomUUID();
  const first = runJson([
    "send",
    claude.id,
    "Can you confirm the billing contract?",
    "--from-session",
    codex.id,
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ]);
  const retry = runJson([
    "send",
    claude.id,
    "This retry must not duplicate delivery",
    "--from-session",
    codex.id,
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ]);
  if (first.message?.id !== retry.message?.id) throw new Error("Idempotent CLI retry produced a duplicate message");

  const inbox = runJson(["inbox", "--session", claude.id, "--unread-only", "--json"]);
  if (inbox.length !== 1 || inbox[0]?.id !== first.message.id) throw new Error("Recipient inbox delivery failed");

  const lease = runJson([
    "reserve",
    "src/billing/**",
    "--session",
    claude.id,
    "--ttl",
    "5",
    "--note",
    "acceptance",
    "--json",
  ]);
  run(["release", lease.id, "--session", claude.id]);

  const status = runJson(["status", "--json"]);
  if (status.status?.sessions?.active < 2) throw new Error("Daemon status lost an active acceptance session");
  process.stdout.write("Pinboard local acceptance passed: presence, idempotent messaging, inbox, and leases.\n");
} finally {
  try {
    run(["daemon", "stop"]);
  } catch {
    daemon.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolveExit) => daemon.once("exit", resolveExit)),
    delay(2_000).then(() => daemon.kill("SIGKILL")),
  ]);
  await rm(pinboardHome, { recursive: true, force: true });
}
