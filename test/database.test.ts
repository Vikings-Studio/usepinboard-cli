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
});
