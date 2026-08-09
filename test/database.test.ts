import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PinboardDatabase } from "../src/storage/database.js";
import { temporaryPaths } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";
import { ensureDirectories } from "../src/platform/paths.js";
import { SCHEMA_MIGRATIONS } from "../src/storage/schema.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local database", () => {
  it("migrates an existing Personal v3 database additively to cloud schema v4", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    await ensureDirectories(paths);
    const legacy = new DatabaseSync(paths.database);
    legacy.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
    for (const migration of SCHEMA_MIGRATIONS.filter((item) => item.version <= 3)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
    }
    legacy.close();
    const migrated = await PinboardDatabase.open(paths);
    expect(migrated.exportSnapshot().schemaVersion).toBe(4);
    expect(migrated.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_outbox'").get()).toBeTruthy();
    migrated.close();
  });

  it("namespaces remote threads and rejects forged repository provenance atomically", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "https://github.com/example/cloud", name: "cloud", root: "/tmp/cloud", branch: "main" };
    const recipient = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const sender = database.registerSession({ id: randomUUID(), provider: "claude-code", repository });
    const cloudRecipient = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const remoteMessageOne = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const remoteMessageTwo = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const remoteSender = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    database.upsertCloudSession("org_1", recipient.id, cloudRecipient, "active");
    const collidingThread = randomUUID();
    database.sendMessage({ senderSessionId: sender.id, to: recipient.id, body: "local", threadId: collidingThread });
    const message = {
      id: remoteMessageOne,
      repositoryId: "repo_cloud",
      threadId: collidingThread,
      body: "remote",
      sender: { userId: "user_2", deviceId: "device_2", sessionId: remoteSender, provider: "codex", branch: "main" },
    };
    expect(database.ingestCloudInbox({ organizationId: "org_1", repositoryId: "repo_cloud", cloudSessionId: cloudRecipient, nextCursor: null, messages: [message] })).toBe(1);
    expect(database.listThreads({ sessionId: recipient.id })).toHaveLength(2);
    const remoteMessage = database.inbox({ sessionId: recipient.id, queuedOnly: true }).find((item) => item.body === "remote");
    if (!remoteMessage) throw new Error("expected cloud message");
    expect(remoteMessage.threadId).not.toBe(collidingThread);
    expect(database.cloudRemoteThreadId("org_1", "repo_cloud", remoteMessage.threadId)).toBe(collidingThread);
    expect(database.cloudLocalThreadId("org_1", "repo_cloud", collidingThread)).toBe(remoteMessage.threadId);
    database.linkCloudRepository({ organizationId: "org_1", repositoryId: "repo_cloud", repositoryIdentity: repository.identity, repositoryName: repository.name });
    const otherRepository = { identity: "https://github.com/example/other", name: "other", root: "/tmp/other", branch: "main" };
    const otherSender = database.registerSession({ id: randomUUID(), provider: "codex", repository: otherRepository });
    database.linkCloudRepository({ organizationId: "org_1", repositoryId: "repo_other", repositoryIdentity: otherRepository.identity, repositoryName: otherRepository.name });
    expect(() => database.queueCloudMessage({
      organizationId: "org_1",
      senderSessionId: otherSender.id,
      recipientUserId: "user_2",
      body: "wrong repository",
      threadId: remoteMessage.threadId,
      idempotencyKey: randomUUID(),
    })).toThrow(/different linked repository/u);
    expect(() => database.ingestCloudInbox({
      organizationId: "org_1",
      repositoryId: "repo_cloud",
      cloudSessionId: cloudRecipient,
      nextCursor: null,
      messages: [{ ...message, id: remoteMessageTwo, repositoryId: "forged_repo" }],
    })).toThrow(/provenance/u);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM cloud_inbox WHERE remote_message_id = ?").get(remoteMessageTwo)).toMatchObject({ count: 0 });
    database.close();
  });

  it("orders cloud receipts and safely hides a superseded delivery", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "https://github.com/example/receipts", name: "receipts", root: "/tmp/receipts", branch: "main" };
    const recipient = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const cloudRecipient = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const remoteSender = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const remoteMessageOne = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const remoteMessageTwo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    database.upsertCloudSession("org_1", recipient.id, cloudRecipient, "active");
    const cloudMessage = (id: string) => ({
      id,
      repositoryId: "repo_receipts",
      threadId: randomUUID(),
      body: "remote",
      sender: { userId: "user_2", deviceId: "device_2", sessionId: remoteSender, provider: "codex", branch: "main" },
    });
    database.ingestCloudInbox({ organizationId: "org_1", repositoryId: "repo_receipts", cloudSessionId: cloudRecipient, nextCursor: null, messages: [cloudMessage(remoteMessageOne)] });
    const materialized = database.inbox({ sessionId: recipient.id, queuedOnly: true })[0];
    if (!materialized) throw new Error("expected cloud message");
    database.markRead(materialized.id, recipient.id);

    let pending = database.pendingCloudReceipts("org_1");
    expect(pending.map((item) => item.kind)).toEqual(["received"]);
    database.markCloudReceiptSent(pending[0]?.id ?? "");
    pending = database.pendingCloudReceipts("org_1");
    expect(pending.map((item) => item.kind)).toEqual(["surfaced"]);
    database.markCloudReceiptFailed(pending[0]?.id ?? "", "retry later");
    expect(database.pendingCloudReceipts("org_1")).toEqual([]);
    database.database.prepare("UPDATE cloud_receipt_outbox SET available_at = 0 WHERE type = 'surfaced'").run();
    pending = database.pendingCloudReceipts("org_1");
    expect(pending.map((item) => item.kind)).toEqual(["surfaced"]);
    database.markCloudReceiptSent(pending[0]?.id ?? "");
    expect(database.pendingCloudReceipts("org_1").map((item) => item.kind)).toEqual(["read"]);

    database.ingestCloudInbox({ organizationId: "org_1", repositoryId: "repo_receipts", cloudSessionId: cloudRecipient, nextCursor: null, messages: [cloudMessage(remoteMessageTwo)] });
    database.supersedeCloudDelivery("org_1", remoteMessageTwo, cloudRecipient);
    expect(database.inbox({ sessionId: recipient.id, queuedOnly: true })).toEqual([]);
    expect(database.database.prepare("SELECT state FROM cloud_inbox WHERE remote_message_id = ?").get(remoteMessageTwo)).toMatchObject({ state: "superseded" });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE cloud_message_id = ?").get(remoteMessageTwo)).toMatchObject({ count: 1 });
    database.close();
  });

  it("rejects reuse of a cloud idempotency key for different canonical content", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const key = randomUUID();
    const first = database.queueCloudOutbox({ organizationId: "org_1", kind: "message", idempotencyKey: key, payload: { body: "one", nested: { a: 1, b: 2 } } });
    const retry = database.queueCloudOutbox({ organizationId: "org_1", kind: "message", idempotencyKey: key, payload: { nested: { b: 2, a: 1 }, body: "one" } });
    expect(retry.id).toBe(first.id);
    expect(() => database.queueCloudOutbox({ organizationId: "org_1", kind: "message", idempotencyKey: key, payload: { body: "two" } })).toThrow(/different operation/u);
    database.close();
  });

  it("bounds cloud retry backoff and dead-letters permanent or exhausted work", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const queued = database.queueCloudOutbox({ organizationId: "org_1", kind: "message", idempotencyKey: randomUUID(), payload: { body: "retry" } });
    for (let attempt = 0; attempt < 10; attempt += 1) database.markCloudOutboxFailed(queued.id, "temporary");
    expect(database.database.prepare("SELECT status, attempts FROM cloud_outbox WHERE id = ?").get(queued.id)).toMatchObject({ status: "dead", attempts: 10 });
    const permanent = database.queueCloudOutbox({ organizationId: "org_1", kind: "message", idempotencyKey: randomUUID(), payload: { body: "bad" } });
    database.markCloudOutboxFailed(permanent.id, "forbidden", true);
    expect(database.database.prepare("SELECT status, attempts FROM cloud_outbox WHERE id = ?").get(permanent.id)).toMatchObject({ status: "dead", attempts: 1 });
    database.close();
  });


  it("creates one durable local identity", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const first = await PinboardDatabase.open(paths);
    const identity = first.localIdentity();
    expect(identity).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.localIdentity()).toBe(identity);
    first.close();

    const reopened = await PinboardDatabase.open(paths);
    expect(reopened.localIdentity()).toBe(identity);
    reopened.close();
  });

  it("routes messages and leases between active sessions", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = {
      identity: "https://github.com/example/api",
      name: "api",
      root: "/tmp/api",
      branch: "main",
    };
    const claude = database.registerSession({ id: randomUUID(), provider: "claude-code", repository, taskLabel: "billing" });
    const codex = database.registerSession({
      id: randomUUID(),
      provider: "codex",
      repository: { ...repository, branch: "checkout" },
      taskLabel: "checkout",
    });

    const sent = database.sendMessage({ senderSessionId: codex.id, to: claude.address, body: "Are you changing the API?" });
    expect(sent.message.recipientSessionId).toBe(claude.id);
    expect(database.inbox({ sessionId: claude.id, queuedOnly: true })).toHaveLength(1);
    expect(database.inbox({ sessionId: claude.id, queuedOnly: true })).toHaveLength(0);
    expect(database.inbox({ sessionId: claude.id, unreadOnly: true })).toHaveLength(1);

    const lease = database.createLease({ sessionId: claude.id, paths: ["src/billing/**"], ttlMinutes: 30, note: "migration" });
    expect(database.listLeases(repository.identity)[0]?.paths).toEqual(["src/billing/**"]);
    expect(database.releaseLease(lease.id, codex.id)).toBe(false);
    expect(database.releaseLease(lease.id, claude.id)).toBe(true);
    expect(database.listLeases(repository.identity)).toHaveLength(0);
    database.close();
  });

  it("resolves ambiguous addresses to the most recent active session", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "local:test", name: "test", root: "/tmp/test", branch: "main" };
    const first = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const second = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    database.heartbeat(first.id);
    const sent = database.sendMessage({ to: first.address, body: "target" });
    expect(sent.message.recipientSessionId).toBe(first.id);
    expect(sent.alternatives.map((session) => session.id)).toContain(second.id);
    database.close();
  });

  it("does not resolve an address to a same-basename repository", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const first = database.registerSession({
      id: randomUUID(),
      provider: "codex",
      repository: {
        identity: "https://github.com/first/api",
        name: "api",
        root: "/tmp/first/api",
        branch: "main",
      },
    });
    const second = database.registerSession({
      id: randomUUID(),
      provider: "codex",
      repository: {
        identity: "https://github.com/second/api",
        name: "api",
        root: "/tmp/second/api",
        branch: "main",
      },
    });

    expect(first.address).not.toBe(second.address);
    const sent = database.sendMessage({ to: first.address, body: "first repository only" });
    expect(sent.message.recipientSessionId).toBe(first.id);
    expect(sent.alternatives).toHaveLength(0);
    expect(database.inbox({ sessionId: second.id, unreadOnly: true })).toHaveLength(0);
    database.close();
  });

  it("rejects a legacy address that is ambiguous across repositories", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const first = database.registerSession({
      id: randomUUID(),
      provider: "codex",
      repository: { identity: "local:first-api", name: "api", root: "/tmp/first-api", branch: "main" },
    });
    const second = database.registerSession({
      id: randomUUID(),
      provider: "codex",
      repository: { identity: "local:second-api", name: "api", root: "/tmp/second-api", branch: "main" },
    });
    const legacyAddress = "local/codex@api#main";
    database.database.prepare("UPDATE sessions SET address = ? WHERE id IN (?, ?)").run(
      legacyAddress,
      first.id,
      second.id,
    );

    expect(() => database.sendMessage({ to: legacyAddress, body: "must not cross repositories" })).toThrow(
      /ambiguous across repositories/u,
    );
    database.close();
  });

  it("only lets the recipient create a read receipt", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "local:receipts", name: "receipts", root: "/tmp/receipts", branch: "main" };
    const sender = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const recipient = database.registerSession({ id: randomUUID(), provider: "claude-code", repository });
    const sent = database.sendMessage({ senderSessionId: sender.id, to: recipient.id, body: "hello" });

    expect(() => database.markRead(sent.message.id, sender.id)).toThrow(/was not found for session/u);
    expect(database.inbox({ sessionId: recipient.id, unreadOnly: true })).toHaveLength(1);
    database.markRead(sent.message.id, recipient.id);
    expect(database.inbox({ sessionId: recipient.id, unreadOnly: true })).toHaveLength(0);
    database.close();
  });

  it("rejects unsafe lease paths before persistence", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "local:leases", name: "leases", root: "/tmp/leases", branch: "main" };
    const owner = database.registerSession({ id: randomUUID(), provider: "codex", repository });

    expect(() => database.createLease({ sessionId: owner.id, paths: ["../outside"], ttlMinutes: 5 })).toThrow(
      /cannot traverse/u,
    );
    expect(database.listLeases(repository.identity)).toHaveLength(0);
    database.close();
  });

  it("returns the original message when a send is retried with the same idempotency key", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "local:idempotency", name: "idempotency", root: "/tmp/idempotency", branch: "main" };
    const recipient = database.registerSession({ id: randomUUID(), provider: "claude-code", repository });
    const key = randomUUID();
    const first = database.sendMessage({ to: recipient.id, body: "deliver once", idempotencyKey: key });
    const retry = database.sendMessage({ to: recipient.id, body: "changed retry body", idempotencyKey: key });

    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.body).toBe("deliver once");
    expect(database.inbox({ sessionId: recipient.id })).toHaveLength(1);
    database.close();
  });

  it("lists durable threads scoped to a participant", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "local:threads", name: "threads", root: "/tmp/threads", branch: "main" };
    const sender = database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const recipient = database.registerSession({ id: randomUUID(), provider: "claude-code", repository });
    const outsider = database.registerSession({ id: randomUUID(), provider: "cli", repository });
    const threadId = randomUUID();
    database.sendMessage({ senderSessionId: sender.id, to: recipient.id, body: "first", threadId });
    database.sendMessage({ senderSessionId: recipient.id, to: sender.id, body: "second", threadId });

    expect(database.listThreads({ sessionId: sender.id })).toMatchObject([
      { id: threadId, messageCount: 2, unreadCount: 1 },
    ]);
    expect(database.listThreads({ sessionId: outsider.id })).toHaveLength(0);
    database.close();
  });

  it("exports a versioned local snapshot without daemon credentials", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const database = await PinboardDatabase.open(paths);
    const repository = { identity: "local:export", name: "export", root: "/tmp/export", branch: "main" };
    database.registerSession({ id: randomUUID(), provider: "codex", repository });
    const snapshot = database.exportSnapshot();

    expect(snapshot).toMatchObject({ format: "pinboard-local-export", formatVersion: 1, schemaVersion: 4 });
    expect(snapshot.localIdentity).toMatch(/^[0-9a-f-]{36}$/u);
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.sessions[0]).not.toHaveProperty("capability_hash");
    expect(JSON.stringify(snapshot)).not.toContain("local-secret");
    database.close();
  });
});
