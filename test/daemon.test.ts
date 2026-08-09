import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon/client.js";
import { startDaemon } from "../src/daemon/server.js";
import type { MessageRecord, SessionRecord } from "../src/domain/types.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon IPC", () => {
  it("requires local auth and completes the presence-message flow", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const daemon = await startDaemon({ version: "test", paths });
    try {
      const unauthorizedStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ socketPath: paths.socket, path: "/health" }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        req.once("error", reject);
        req.end();
      });
      expect(unauthorizedStatus).toBe(401);

      const client = new DaemonClient(paths);
      const repository = { identity: "local:daemon", name: "daemon", root: "/tmp/daemon", branch: "main" };
      const recipient = await client.post<SessionRecord>("/v1/sessions", {
        id: randomUUID(),
        provider: "claude-code",
        repository,
      });
      const sender = await client.post<SessionRecord>("/v1/sessions", {
        id: randomUUID(),
        provider: "codex",
        repository: { ...repository, branch: "feature" },
      });
      const sent = await client.post<{ message: MessageRecord }>("/v1/messages", {
        senderSessionId: sender.id,
        to: recipient.address,
        body: "hello",
      });
      const inbox = await client.get<MessageRecord[]>(`/v1/inbox?sessionId=${recipient.id}&unreadOnly=true`);
      expect(inbox[0]?.id).toBe(sent.message.id);
      expect(await client.get("/health")).toEqual({ ok: true, version: "test" });
    } finally {
      await daemon.close();
    }
  });
});
