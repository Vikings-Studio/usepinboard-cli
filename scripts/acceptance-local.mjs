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

function run(args, cwd = root, extraEnvironment = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...environment, ...extraEnvironment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runJson(args, cwd = root, extraEnvironment = {}) {
  return JSON.parse(run(args, cwd, extraEnvironment));
}

function runHook(payload, cwd = root) {
  return execFileSync(process.execPath, [cli, "hook", "claude-code"], {
    cwd,
    env: environment,
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
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

  const claudeRegistration = runJson(["debug-register", "--provider", "claude-code", "--task", "billing"]);
  const codexRegistration = runJson(["debug-register", "--provider", "codex", "--task", "checkout"]);
  const claude = claudeRegistration.session;
  const codex = codexRegistration.session;
  const claudeEnvironment = { PINBOARD_SESSION_CAPABILITY: claudeRegistration.capability };
  const codexEnvironment = { PINBOARD_SESSION_CAPABILITY: codexRegistration.capability };
  const presence = runJson(["who", "--include-idle", "--json"]);
  if (!presence.some((session) => session.id === claude.id) || !presence.some((session) => session.id === codex.id)) {
    throw new Error("Two-session presence discovery failed");
  }

  const hookProviderSessionId = "acceptance-claude-hook-session";
  runHook({ hook_event_name: "UserPromptSubmit", session_id: hookProviderSessionId, cwd: root, prompt: "hook acceptance" });
  const presenceWithHook = runJson(["who", "--include-idle", "--json"]);
  const hookSession = presenceWithHook.find((candidate) => candidate.providerSessionId === hookProviderSessionId);
  if (!hookSession) throw new Error("Claude lifecycle hook did not register presence");
  if (hookSession.taskLabel) throw new Error("Claude prompt content leaked into presence metadata");

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
  ], root, codexEnvironment);
  const retry = runJson([
    "send",
    claude.id,
    "This retry must not duplicate delivery",
    "--from-session",
    codex.id,
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ], root, codexEnvironment);
  if (first.message?.id !== retry.message?.id) throw new Error("Idempotent CLI retry produced a duplicate message");

  const hookMessage = runJson([
    "send",
    hookSession.id,
    "Safe-point delivery contract",
    "--from-session",
    codex.id,
    "--idempotency-key",
    randomUUID(),
    "--json",
  ], root, codexEnvironment);
  const safePointRaw = runHook({ hook_event_name: "PostToolUse", session_id: hookProviderSessionId, cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "README.md") } });
  const safePoint = JSON.parse(safePointRaw);
  const safeContext = safePoint.hookSpecificOutput?.additionalContext ?? "";
  if (!safeContext.includes(hookMessage.message.id) || !safeContext.includes("UNTRUSTED MESSAGE FROM ANOTHER AGENT")) {
    throw new Error("Claude safe-point hook did not surface attributed untrusted context");
  }
  const repeatedSafePoint = runHook({ hook_event_name: "PostToolUse", session_id: hookProviderSessionId, cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "README.md") } });
  if (repeatedSafePoint !== "") throw new Error("Claude hook delivered the same queued message more than once");

  const inbox = runJson(["inbox", "--session", claude.id, "--unread-only", "--json"], root, claudeEnvironment);
  if (inbox.length !== 1 || inbox[0]?.id !== first.message.id) throw new Error("Recipient inbox delivery failed");
  const reply = runJson([
    "send",
    codex.id,
    "The billing contract is confirmed.",
    "--from-session",
    claude.id,
    "--thread",
    first.message.threadId,
    "--idempotency-key",
    randomUUID(),
    "--json",
  ], root, claudeEnvironment);
  const replyInbox = runJson(["inbox", "--session", codex.id, "--unread-only", "--json"], root, codexEnvironment);
  if (replyInbox.length !== 1 || replyInbox[0]?.id !== reply.message.id) throw new Error("Same-thread reply failed");
  const threads = runJson(["threads", "--session", claude.id, "--json"], root, claudeEnvironment);
  if (threads.length !== 1 || threads[0]?.id !== first.message.threadId || threads[0]?.messageCount !== 2) {
    throw new Error("Durable conversation history failed");
  }

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
  ], root, claudeEnvironment);
  const statusWithLease = runJson(["status", "--json"]);
  if (statusWithLease.status?.activeLeases !== 1) throw new Error("Lease did not appear in daemon discovery state");
  const preEditRaw = runHook({
    hook_event_name: "PreToolUse",
    session_id: hookProviderSessionId,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "billing", "contract.ts") },
  });
  const preEdit = JSON.parse(preEditRaw);
  if (!(preEdit.hookSpecificOutput?.additionalContext ?? "").includes("src/billing/**")) {
    throw new Error("Claude pre-edit hook did not surface the advisory lease");
  }
  run(["release", lease.id, "--session", claude.id], root, claudeEnvironment);

  const status = runJson(["status", "--json"]);
  if (status.status?.sessions?.active < 2) throw new Error("Daemon status lost an active acceptance session");
  run(["session", "end", "--id", claude.id], root, claudeEnvironment);
  run(["session", "end", "--id", codex.id], root, codexEnvironment);
  runHook({ hook_event_name: "SessionEnd", session_id: hookProviderSessionId, cwd: root, reason: "other" });
  const endedPresence = runJson(["who", "--repo", claude.repositoryIdentity, "--include-idle", "--json"]);
  if (endedPresence.some((candidate) => candidate.id === claude.id || candidate.id === codex.id || candidate.id === hookSession.id)) {
    throw new Error("Ended sessions remained discoverable");
  }
  process.stdout.write("Pinboard local acceptance passed: presence, idempotent messaging, reply, history, Claude safe-point delivery, pre-edit leases, and end signals.\n");
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
