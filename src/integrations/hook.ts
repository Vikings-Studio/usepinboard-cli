import { createHash } from "node:crypto";
import { MAX_REQUEST_BYTES } from "../constants.js";
import type { Provider } from "../domain/types.js";
import { detectRepository } from "../domain/repository.js";
import { DaemonClient } from "../daemon/client.js";
import type { SessionRegistration } from "../domain/types.js";

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function parseHookPayload(raw: Buffer): Record<string, unknown> {
  if (raw.length > MAX_REQUEST_BYTES) throw new Error("Provider hook input exceeds 64 KiB");
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
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Provider hook input exceeds 64 KiB");
    chunks.push(buffer);
  }
  return parseHookPayload(Buffer.concat(chunks));
}

function stringField(input: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export async function handleProviderHook(event: string, provider: Provider): Promise<void> {
  const input = await readStdin();
  const providerSessionId =
    stringField(input, "session_id", "sessionId", "conversation_id", "thread_id") ??
    `${provider}:${process.cwd()}:${process.ppid}`;
  const sessionId = stableUuid(`${provider}:${providerSessionId}`);
  const cwd = stringField(input, "cwd", "working_directory") ?? process.cwd();
  const client = new DaemonClient();

  const taskLabel = stringField(input, "prompt", "task", "task_label");
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
  }
}
