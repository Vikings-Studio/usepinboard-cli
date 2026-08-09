import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PinboardDatabase } from "../src/storage/database.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local database", () => {
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

    expect(snapshot).toMatchObject({ format: "pinboard-local-export", formatVersion: 1, schemaVersion: 2 });
    expect(snapshot.localIdentity).toMatch(/^[0-9a-f-]{36}$/u);
    expect(snapshot.repositories).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("local-secret");
    database.close();
  });
});
