import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { MAX_HOOK_BYTES, MAX_TASK_LABEL_BYTES } from "../constants.js";
import type { Provider } from "../domain/types.js";
import { detectRepository } from "../domain/repository.js";
import { DaemonClient } from "../daemon/client.js";
import type { LeaseRecord, MessageRecord, SessionRegistration } from "../domain/types.js";
import { formatUntrusted } from "../security/untrusted.js";
import { sanitizeUntrustedText, truncateUtf8 } from "../security/untrusted.js";

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function parseHookPayload(raw: Buffer): Record<string, unknown> {
  if (raw.length > MAX_HOOK_BYTES) throw new Error("Provider hook input exceeds 8 MiB");
  if (raw.length === 0) return {};
  const value = JSON.parse(raw.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider hook input must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_BYTES) throw new Error("Provider hook input exceeds 8 MiB");
    chunks.push(buffer);
  }
  return parseHookPayload(Buffer.concat(chunks));
}

function globRegex(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${pattern}$`, "u");
}

export function leaseOverlapsToolInput(lease: LeaseRecord, input: Record<string, unknown>, repositoryRoot: string): boolean {
  const rawToolInput = input.tool_input ?? input.toolInput;
  if (!rawToolInput || typeof rawToolInput !== "object" || Array.isArray(rawToolInput)) return false;
  const rawPath = (rawToolInput as Record<string, unknown>).file_path
    ?? (rawToolInput as Record<string, unknown>).notebook_path
    ?? (rawToolInput as Record<string, unknown>).path;
  if (typeof rawPath !== "string" || !rawPath) return false;
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(repositoryRoot, rawPath);
  const repositoryRelative = relative(resolve(repositoryRoot), absolute).replaceAll("\\", "/");
  if (!repositoryRelative || repositoryRelative === ".." || repositoryRelative.startsWith("../")) return false;
  return lease.paths.some((glob) => globRegex(glob).test(repositoryRelative));
}

function stringField(input: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function resolveHookEvent(input: Record<string, unknown>): string {
  return stringField(input, "hook_event_name", "hookEventName", "event") ?? "Unknown";
}

export function hookOutput(event: string, messages: MessageRecord[], leases: LeaseRecord[] = []): Record<string, unknown> | null {
  const supportsMessages = ["UserPromptSubmit", "PostToolUse", "Stop"].includes(event);
  const supportsLeases = event === "PreToolUse";
  if ((!supportsMessages || messages.length === 0) && (!supportsLeases || leases.length === 0)) return null;
  const messageContext = supportsMessages ? messages.map((message) => [
    `Pinboard message ${message.id} in thread ${message.threadId}:`,
    formatUntrusted({ kind: "message", sender: message.senderAddress, body: message.body }),
    `After you consume it, acknowledge with the Pinboard MCP mark_read tool using message_id ${message.id}.`,
  ].join("\n")).join("\n\n") : "";
  const leaseContext = supportsLeases ? leases.map((lease) => [
    `Advisory Pinboard lease ${lease.id} is active for ${lease.paths.join(", ")} until ${lease.expiresAt}.`,
    `Owner: ${lease.ownerAddress}. Coordinate before editing overlapping files. This lease does not block the tool.`,
    ...(lease.note ? [formatUntrusted({ kind: "lease", sender: lease.ownerAddress, body: lease.note })] : []),
  ].join("\n")).join("\n\n") : "";
  const additionalContext = [messageContext, leaseContext].filter(Boolean).join("\n\n");
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  };
}

export async function handleProviderHook(provider: Provider): Promise<Record<string, unknown> | null> {
  const input = await readStdin();
  const event = resolveHookEvent(input);
  const providerSessionId =
    stringField(input, "session_id", "sessionId", "conversation_id", "thread_id") ??
    `${provider}:${process.cwd()}:${process.ppid}`;
  const sessionId = stableUuid(`${provider}:${providerSessionId}`);
  const cwd = stringField(input, "cwd", "working_directory") ?? process.cwd();
  const client = new DaemonClient();

  const rawTaskLabel = stringField(input, "task_label", "session_title", "task");
  const taskLabel = rawTaskLabel
    ? truncateUtf8(sanitizeUntrustedText(rawTaskLabel), MAX_TASK_LABEL_BYTES)
    : undefined;
  const repository = detectRepository(cwd);
  const registration = await client.post<SessionRegistration>("/v1/sessions", {
    id: sessionId,
    provider,
    providerSessionId,
    repository,
    ...(taskLabel ? { taskLabel } : {}),
    pid: process.ppid,
  });
  if (/^(SessionEnd|session_end)$/u.test(event)) {
    await client.post(`/v1/sessions/${sessionId}/end`, {}, registration.capability);
    return null;
  }
  const messages = ["UserPromptSubmit", "PostToolUse", "Stop"].includes(event)
    ? await client.get<MessageRecord[]>(
      `/v1/inbox?sessionId=${encodeURIComponent(sessionId)}&unreadOnly=true&queuedOnly=true&limit=10`,
      registration.capability,
    )
    : [];
  const leases = event === "PreToolUse"
    ? (await client.get<LeaseRecord[]>(`/v1/leases?repo=${encodeURIComponent(repository.identity)}`))
      .filter((lease) => lease.ownerSessionId !== sessionId && leaseOverlapsToolInput(lease, input, repository.root))
    : [];
  return hookOutput(event, messages, leases);
}
