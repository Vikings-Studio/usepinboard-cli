import { randomUUID } from "node:crypto";
import type { PinboardConfig } from "../config/settings.js";
import type { SessionRecord } from "../domain/types.js";
import type { PinboardDatabase } from "../storage/database.js";
import { CloudClientError, RelayClient } from "./client.js";
import { isCloudResourceId } from "./identifiers.js";

export interface CloudSyncResult {
  sessionsPushed: number;
  sessionsEnded: number;
  sessionsFailed: number;
  messagesSent: number;
  messagesFailed: number;
  messagesReceived: number;
  receiptsSent: number;
  receiptsFailed: number;
}

function sessionBody(session: SessionRecord, repositoryId: string): Record<string, unknown> {
  return {
    repositoryId,
    repositoryIdentity: session.repositoryIdentity,
    repositoryName: session.repositoryName,
    branch: session.branch,
    provider: session.provider,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    ...(session.taskLabel ? { taskLabel: session.taskLabel } : {}),
  };
}

function parseInbox(value: unknown): { messages: Array<Record<string, unknown>>; nextCursor: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay inbox response is invalid");
  const record = value as { data?: unknown; meta?: unknown };
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)
    || !record.meta || typeof record.meta !== "object" || Array.isArray(record.meta)) throw new Error("Relay inbox response is invalid");
  const messages = (record.data as { messages?: unknown }).messages;
  const nextCursor = (record.meta as { nextCursor?: unknown }).nextCursor;
  if (!Array.isArray(messages) || !messages.every((message) => message !== null && typeof message === "object" && !Array.isArray(message))) {
    throw new Error("Relay inbox messages are invalid");
  }
  if (nextCursor !== undefined && nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length > 4096)) {
    throw new Error("Relay inbox cursor is invalid");
  }
  return { messages: messages as Array<Record<string, unknown>>, nextCursor: nextCursor ?? null };
}

function isPermanentCloudFailure(error: unknown): boolean {
  if (error instanceof CloudClientError && error.code === "INVALID_RECEIPT_TRANSITION") return false;
  return error instanceof CloudClientError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
}

function parseSentMessage(value: unknown): { id: string; threadId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay message response is invalid");
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Relay message response is invalid");
  const message = (data as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Relay message response is invalid");
  const { id, threadId } = message as { id?: unknown; threadId?: unknown };
  if (!isCloudResourceId(id) || !isCloudResourceId(threadId)) throw new Error("Relay message response identifiers are invalid");
  return { id, threadId };
}

function parseReceipt(value: unknown, expected: { messageId: string; sessionId: string; type: string }): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Relay receipt response is invalid");
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Relay receipt response is invalid");
  const receipt = data as { messageId?: unknown; sessionId?: unknown; type?: unknown; receiptId?: unknown };
  if (receipt.messageId !== expected.messageId || receipt.type !== expected.type || !isCloudResourceId(receipt.receiptId)
    || (receipt.sessionId !== undefined && receipt.sessionId !== expected.sessionId)) throw new Error("Relay receipt response does not match the request");
}

export async function syncCloudOnce(input: {
  database: PinboardDatabase;
  config: PinboardConfig;
  token: string;
  client?: RelayClient;
}): Promise<CloudSyncResult> {
  const cloud = input.config.cloud;
  if (!cloud.enabled || !cloud.apiUrl || !cloud.organizationId) throw new Error("Pinboard Cloud is not connected");
  if (cloud.syncPaused) throw new Error("Cloud sync is paused. Run `pinboard sync resume` first.");
  const client = input.client ?? new RelayClient(cloud.apiUrl, input.token);
  const bootstrap = await client.bootstrap();
  if (bootstrap.organizationId !== cloud.organizationId || bootstrap.userId !== cloud.userId || bootstrap.deviceId !== cloud.deviceId) {
    throw new Error("Relay identity no longer matches the configured cloud connection");
  }
  const allowedRepositories = new Set(bootstrap.repositoryIds);
  const links = input.database.listCloudRepositories(cloud.organizationId);
  const linkByIdentity = new Map(links.map((link) => [link.repositoryIdentity, link]));
  const sessions = input.database.listSessionsForCloud();
  let sessionsPushed = 0;
  let sessionsEnded = 0;
  let sessionsFailed = 0;
  let messagesReceived = 0;

  for (const session of sessions) {
    const link = linkByIdentity.get(session.repositoryIdentity);
    if (!link || !allowedRepositories.has(link.repositoryId)) continue;
    try {
      const existingLink = input.database.cloudSessionLink(cloud.organizationId, session.id);
      let cloudSessionId = existingLink?.cloudSessionId ?? null;
      if (session.state === "ended" || session.state === "stale") {
        if (cloudSessionId && existingLink?.lastState !== session.state) {
          await client.post(`/v1/sessions/${encodeURIComponent(cloudSessionId)}/end`, {}, randomUUID());
          input.database.upsertCloudSession(cloud.organizationId, session.id, cloudSessionId, session.state);
          sessionsEnded += 1;
        }
        continue;
      }
      if (!cloudSessionId) {
        const response = await client.post<{ data: { session: { id: string } } }>(
          "/v1/sessions",
          sessionBody(session, link.repositoryId),
          session.id,
        );
        cloudSessionId = response.data.session.id;
        if (!isCloudResourceId(cloudSessionId)) throw new Error("Relay session response is missing a UUID id");
        input.database.upsertCloudSession(cloud.organizationId, session.id, cloudSessionId, session.state);
      } else {
        await client.patch(
          `/v1/sessions/${encodeURIComponent(cloudSessionId)}/presence`,
          session.taskLabel ? { taskLabel: session.taskLabel } : {},
          randomUUID(),
        );
        input.database.upsertCloudSession(cloud.organizationId, session.id, cloudSessionId, session.state);
      }
      sessionsPushed += 1;
      // The relay API cursor paginates a descending snapshot; it is not an
      // incremental high-water mark. Always restart at page one so newly-created
      // messages cannot be skipped, and rely on the durable remote-id constraint
      // for deduplication across runs.
      let cursor: string | null = null;
      const visited = new Set<string>();
      for (let page = 0; page < 20; page += 1) {
        const query = new URLSearchParams({ repositoryId: link.repositoryId, sessionId: cloudSessionId, limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const inbox = parseInbox(await client.get<unknown>(`/v1/messages/inbox?${query.toString()}`));
        messagesReceived += input.database.ingestCloudInbox({
          organizationId: cloud.organizationId,
          repositoryId: link.repositoryId,
          cloudSessionId,
          nextCursor: inbox.nextCursor,
          messages: inbox.messages,
        });
        if (!inbox.nextCursor) break;
        if (visited.has(inbox.nextCursor)) throw new Error("Relay returned a repeated inbox cursor");
        visited.add(inbox.nextCursor);
        cursor = inbox.nextCursor;
        if (page === 19) throw new Error("Relay inbox exceeded the 20-page synchronization bound");
      }
    } catch {
      sessionsFailed += 1;
    }
  }

  let messagesSent = 0;
  let messagesFailed = 0;
  for (const item of input.database.pendingCloudOutbox(cloud.organizationId)) {
    try {
      if (item.kind !== "message") throw new Error(`Unsupported cloud outbox kind: ${item.kind}`);
      const localSender = typeof item.payload.senderSessionId === "string" ? item.payload.senderSessionId : "";
      const senderSessionId = input.database.cloudSessionId(cloud.organizationId, localSender);
      if (!senderSessionId) throw new Error("Sender session has not been synchronized");
      const localThreadId = typeof item.payload.localThreadId === "string" ? item.payload.localThreadId : "";
      if (!localThreadId) throw new Error("Cloud outbox message is missing its local thread mapping");
      const { localThreadId: _localThreadId, ...wirePayload } = item.payload;
      void _localThreadId;
      const sent = parseSentMessage(await client.post("/v1/messages", { ...wirePayload, senderSessionId }, item.idempotencyKey));
      const repositoryId = typeof item.payload.repositoryId === "string" ? item.payload.repositoryId : "";
      input.database.recordCloudThreadMapping(cloud.organizationId, repositoryId, localThreadId, sent.threadId);
      input.database.markCloudOutboxSent(item.id);
      messagesSent += 1;
    } catch (error) {
      input.database.markCloudOutboxFailed(item.id, error instanceof Error ? error.message : String(error), isPermanentCloudFailure(error));
      messagesFailed += 1;
    }
  }

  let receiptsSent = 0;
  let receiptsFailed = 0;
  for (let rank = 0; rank < 3; rank += 1) {
    const items = input.database.pendingCloudReceipts(cloud.organizationId);
    if (items.length === 0) break;
    for (const item of items) {
      const messageId = typeof item.payload.messageId === "string" ? item.payload.messageId : "";
      const sessionId = typeof item.payload.sessionId === "string" ? item.payload.sessionId : "";
      const type = typeof item.payload.type === "string" ? item.payload.type : "";
      if (!isCloudResourceId(messageId) || !isCloudResourceId(sessionId) || !["received", "surfaced", "read"].includes(type)) {
        input.database.markCloudReceiptFailed(item.id, "Malformed durable receipt", true);
        receiptsFailed += 1;
        continue;
      }
      try {
        const response = await client.post(
          `/v1/messages/${encodeURIComponent(messageId)}/receipts`,
          { type, sessionId },
          item.idempotencyKey,
        );
        parseReceipt(response, { messageId, sessionId, type });
        input.database.markCloudReceiptSent(item.id);
        receiptsSent += 1;
      } catch (error) {
        if (error instanceof CloudClientError && error.code === "DELIVERY_SUPERSEDED") {
          input.database.supersedeCloudDelivery(cloud.organizationId, messageId, sessionId);
        } else {
          input.database.markCloudReceiptFailed(item.id, error instanceof Error ? error.message : String(error), isPermanentCloudFailure(error));
        }
        receiptsFailed += 1;
      }
    }
  }
  return { sessionsPushed, sessionsEnded, sessionsFailed, messagesSent, messagesFailed, messagesReceived, receiptsSent, receiptsFailed };
}
