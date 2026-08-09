import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { SpikeClient } from "../src/cloud/client.js";
import { syncCloudOnce } from "../src/cloud/sync.js";
import type { PinboardConfig } from "../src/config/settings.js";
import { PinboardDatabase } from "../src/storage/database.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("experimental cloud synchronization", () => {
  it("pushes presence, replays the durable outbox, pulls inbox once, and flushes receipts", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "https://github.com/example/api", name: "api", root: "/tmp/api", branch: "main" };
    const local = database.registerSession({ id: randomUUID(), provider: "codex", repository, taskLabel: "checkout" });
    database.setCloudConnection({ organizationId: "org_1", apiUrl: "http://127.0.0.1", userId: "user_1", deviceId: "device_1" });
    database.linkCloudRepository({ organizationId: "org_1", repositoryId: "api", repositoryIdentity: repository.identity, repositoryName: repository.name });
    const queued = database.queueCloudMessage({
      organizationId: "org_1",
      senderSessionId: local.id,
      recipientUserId: "user_2",
      body: "hello remotely",
      idempotencyKey: randomUUID(),
    });

    const remoteThreadId = "11111111-1111-4111-8111-111111111111";
    const remoteSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const remoteSenderSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const receivedMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sentMessageIds = ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"];
    const receiptIds = ["ffffffff-ffff-4fff-8fff-ffffffffffff", "12345678-1234-4234-8234-123456789abc"];
    const sentBodies: Array<Record<string, unknown>> = [];
    const receiptTypes: string[] = [];
    const seen = { sessions: 0, ended: 0, messages: 0, receipts: 0, inboxFirstPages: 0 };
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer design_partner_token_0123456789");
      expect(request.headers["x-pinboard-protocol-version"]).toBe("1");
      const url = new URL(request.url ?? "/", "http://localhost");
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        const send = (value: unknown): void => {
          response.writeHead(200, { "content-type": "application/json", "x-request-id": "req_test" });
          response.end(JSON.stringify(value));
        };
        if (url.pathname === "/v1/spike/bootstrap") return send({ data: { organizationId: "org_1", userId: "user_1", deviceId: "device_1", repositoryIds: ["api"], protocolVersion: 1 } });
        if (url.pathname === "/v1/spike/sessions") {
          expect(request.headers["idempotency-key"]).toBe(local.id);
          expect(JSON.parse(body)).toMatchObject({ repositoryId: "api", repositoryIdentity: repository.identity });
          seen.sessions += 1;
          return send({ data: { session: { id: remoteSessionId } } });
        }
        if (url.pathname === `/v1/spike/sessions/${remoteSessionId}/presence` && request.method === "PATCH") {
          expect(request.headers["idempotency-key"]).toBeTruthy();
          return send({ data: { session: { id: remoteSessionId } } });
        }
        if (url.pathname === `/v1/spike/sessions/${remoteSessionId}/end` && request.method === "POST") {
          seen.ended += 1;
          return send({ data: { session: { id: remoteSessionId, state: "ended" } } });
        }
        if (url.pathname === "/v1/spike/messages" && request.method === "POST") {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          expect(parsed).toMatchObject({ senderSessionId: remoteSessionId, recipientUserId: "user_2" });
          expect(parsed).not.toHaveProperty("localThreadId");
          sentBodies.push(parsed);
          seen.messages += 1;
          return send({ data: { message: { id: sentMessageIds[seen.messages - 1], threadId: parsed.threadId ?? remoteThreadId } } });
        }
        if (url.pathname === "/v1/spike/messages/inbox") {
          expect(url.searchParams.get("session_id")).toBe(remoteSessionId);
          const cursor = url.searchParams.get("cursor");
          if (!cursor) seen.inboxFirstPages += 1;
          const messages = cursor || seen.messages === 0 ? [] : [{ id: receivedMessageId, repositoryId: "api", threadId: remoteThreadId, sender: { userId: "user_2", deviceId: "device_2", sessionId: remoteSenderSessionId, provider: "claude-code", branch: "feature" }, body: "remote reply" }];
          return send({ data: { messages }, meta: { nextCursor: cursor ? null : "cursor_1" } });
        }
        if (url.pathname === `/v1/spike/messages/${receivedMessageId}/receipts`) {
          const parsed = JSON.parse(body) as { sessionId: string; type: string };
          expect(parsed).toMatchObject({ sessionId: remoteSessionId });
          receiptTypes.push(parsed.type);
          seen.receipts += 1;
          return send({ data: { messageId: receivedMessageId, type: parsed.type, receiptId: receiptIds[seen.receipts - 1] } });
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const config: PinboardConfig = {
      version: 2,
      idleMinutes: 5,
      staleMinutes: 30,
      cloud: { enabled: true, apiUrl, organizationId: "org_1", userId: "user_1", deviceId: "device_1", syncPaused: false },
    };
    const client = new SpikeClient(apiUrl, "design_partner_token_0123456789");
    const first = await syncCloudOnce({ database, config, token: "unused_but_valid_000", client });
    expect(first).toEqual({ sessionsPushed: 1, sessionsEnded: 0, sessionsFailed: 0, messagesSent: 1, messagesFailed: 0, messagesReceived: 0, receiptsSent: 0, receiptsFailed: 0 });
    expect(seen).toMatchObject({ sessions: 1, ended: 0, messages: 1, receipts: 0, inboxFirstPages: 1 });
    expect(database.cloudRemoteThreadId("org_1", "api", queued.payload.localThreadId as string)).toBe(remoteThreadId);
    const second = await syncCloudOnce({ database, config, token: "unused_but_valid_000", client });
    expect(second).toMatchObject({ messagesReceived: 1, messagesSent: 0, receiptsSent: 1 });
    const delivered = database.inbox({ sessionId: local.id, queuedOnly: true })[0];
    if (!delivered) throw new Error("expected a delivered cloud message");
    expect(delivered.body).toBe("remote reply");
    expect(delivered.threadId).toBe(queued.payload.localThreadId);
    expect(delivered.senderAddress).toBe(`team/org_1/user_2/device_2/claude-code@api#feature~${remoteSenderSessionId}`);
    expect(database.cloudQueueStatus("org_1")).toMatchObject({ outboxPending: 0, inboxQueued: 0, receiptsPending: 1 });
    database.queueCloudMessage({ organizationId: "org_1", senderSessionId: local.id, recipientUserId: "user_2", body: "reply again", threadId: delivered.threadId, idempotencyKey: randomUUID() });
    const third = await syncCloudOnce({ database, config, token: "unused_but_valid_000", client });
    expect(third.messagesSent).toBe(1);
    expect(third.messagesReceived).toBe(0);
    expect(sentBodies[0]).not.toHaveProperty("threadId");
    expect(sentBodies[1]).toMatchObject({ threadId: remoteThreadId, body: "reply again" });
    expect(receiptTypes).toEqual(["received", "surfaced"]);
    expect(seen.inboxFirstPages).toBe(3);
    database.endSession(local.id);
    const fourth = await syncCloudOnce({ database, config, token: "unused_but_valid_000", client });
    expect(fourth).toMatchObject({ sessionsPushed: 0, sessionsEnded: 1 });
    expect(seen.ended).toBe(1);
    const fifth = await syncCloudOnce({ database, config, token: "unused_but_valid_000", client });
    expect(fifth).toMatchObject({ sessionsPushed: 0, sessionsEnded: 0 });
    expect(seen.ended).toBe(1);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });

  it("continues durable outbox processing when one session inbox response is malformed", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "https://github.com/example/web", name: "web", root: "/tmp/web", branch: "main" };
    const local = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    database.setCloudConnection({ organizationId: "org_1", apiUrl: "http://127.0.0.1", userId: "user_1", deviceId: "device_1" });
    database.linkCloudRepository({ organizationId: "org_1", repositoryId: "web", repositoryIdentity: repository.identity, repositoryName: repository.name });
    database.queueCloudMessage({ organizationId: "org_1", senderSessionId: local.id, recipientUserId: "user_2", body: "still send", idempotencyKey: randomUUID() });
    let messages = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      request.resume();
      request.once("end", () => {
        const send = (value: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
        };
        if (url.pathname === "/v1/spike/bootstrap") return send({ data: { organizationId: "org_1", userId: "user_1", deviceId: "device_1", repositoryIds: ["web"], protocolVersion: 1 } });
        if (url.pathname === "/v1/spike/sessions") return send({ data: { session: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } });
        if (url.pathname === "/v1/spike/messages/inbox") return send({ data: { messages: "not-an-array" }, meta: {} });
        if (url.pathname === "/v1/spike/messages") {
          messages += 1;
          return send({ data: { message: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", threadId: "22222222-2222-4222-8222-222222222222" } } });
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const config: PinboardConfig = { version: 2, idleMinutes: 5, staleMinutes: 30, cloud: { enabled: true, apiUrl, organizationId: "org_1", userId: "user_1", deviceId: "device_1", syncPaused: false } };
    try {
      const result = await syncCloudOnce({ database, config, token: "design_partner_token_0123456789" });
      expect(result).toMatchObject({ sessionsFailed: 1, messagesSent: 1, messagesFailed: 0 });
      expect(messages).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    }
  });

  it("retries invalid receipt transitions and discards a superseded delivery", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "https://github.com/example/errors", name: "errors", root: "/tmp/errors", branch: "main" };
    const local = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const remoteSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const remoteSenderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const remoteMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    database.setCloudConnection({ organizationId: "org_1", apiUrl: "http://127.0.0.1", userId: "user_1", deviceId: "device_1" });
    database.linkCloudRepository({ organizationId: "org_1", repositoryId: "errors", repositoryIdentity: repository.identity, repositoryName: repository.name });
    database.upsertCloudSession("org_1", local.id, remoteSessionId, "active");
    database.ingestCloudInbox({
      organizationId: "org_1",
      repositoryId: "errors",
      cloudSessionId: remoteSessionId,
      nextCursor: null,
      messages: [{
        id: remoteMessageId,
        repositoryId: "errors",
        threadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        body: "claim me",
        sender: { userId: "user_2", deviceId: "device_2", sessionId: remoteSenderId, provider: "codex", branch: "main" },
      }],
    });
    expect(database.inbox({ sessionId: local.id, queuedOnly: true })).toHaveLength(1);
    let errorCode = "INVALID_RECEIPT_TRANSITION";
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      request.resume();
      request.once("end", () => {
        if (url.pathname === "/v1/spike/bootstrap") {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { organizationId: "org_1", userId: "user_1", deviceId: "device_1", repositoryIds: ["errors"], protocolVersion: 1 } }));
          return;
        }
        if (url.pathname === `/v1/spike/sessions/${remoteSessionId}/presence`) {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { session: { id: remoteSessionId } } }));
          return;
        }
        if (url.pathname === "/v1/spike/messages/inbox") {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { messages: [] }, meta: { nextCursor: null } }));
          return;
        }
        if (url.pathname === `/v1/spike/messages/${remoteMessageId}/receipts`) {
          response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: errorCode, message: "receipt rejected" } }));
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test relay did not bind");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const config: PinboardConfig = { version: 2, idleMinutes: 5, staleMinutes: 30, cloud: { enabled: true, apiUrl, organizationId: "org_1", userId: "user_1", deviceId: "device_1", syncPaused: false } };
    try {
      const retry = await syncCloudOnce({ database, config, token: "design_partner_token_0123456789" });
      expect(retry).toMatchObject({ receiptsSent: 0, receiptsFailed: 1 });
      expect(database.database.prepare("SELECT type, status, attempts FROM cloud_receipt_outbox ORDER BY CASE type WHEN 'received' THEN 1 ELSE 2 END").all()).toEqual([
        expect.objectContaining({ type: "received", status: "pending", attempts: 1 }),
        expect.objectContaining({ type: "surfaced", status: "pending", attempts: 0 }),
      ]);
      database.database.prepare("UPDATE cloud_receipt_outbox SET available_at = 0 WHERE type = 'received'").run();
      errorCode = "DELIVERY_SUPERSEDED";
      const superseded = await syncCloudOnce({ database, config, token: "design_partner_token_0123456789" });
      expect(superseded).toMatchObject({ receiptsSent: 0, receiptsFailed: 1 });
      expect(database.database.prepare("SELECT state FROM cloud_inbox WHERE remote_message_id = ?").get(remoteMessageId)).toMatchObject({ state: "superseded" });
      expect(database.database.prepare("SELECT DISTINCT status FROM cloud_receipt_outbox WHERE remote_message_id = ?").all(remoteMessageId)).toEqual([{ status: "discarded" }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    }
  });
});
