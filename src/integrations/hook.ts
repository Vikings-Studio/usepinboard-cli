import { createHash } from "node:crypto";
import type { Provider } from "../domain/types.js";
import { detectRepository } from "../domain/repository.js";
import { DaemonClient } from "../daemon/client.js";

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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

  if (/^(SessionEnd|session_end)$/u.test(event)) {
    await client.post(`/v1/sessions/${sessionId}/end`);
    return;
  }

  const taskLabel = stringField(input, "prompt", "task", "task_label");
  const repository = detectRepository(cwd);
  await client.post("/v1/sessions", {
    id: sessionId,
    provider,
    providerSessionId,
    repository,
    ...(taskLabel ? { taskLabel } : {}),
    pid: process.ppid,
  });
}
