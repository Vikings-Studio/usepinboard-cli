import { randomBytes, randomUUID } from "node:crypto";
import { access, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon/client.js";
import { stopBackgroundDaemon } from "../src/daemon/lifecycle.js";
import { startDaemon } from "../src/daemon/server.js";
import type { MessageRecord, SessionRegistration } from "../src/domain/types.js";
import { temporaryPaths } from "./helpers.js";
import { readLocalSecret } from "../src/security/local-auth.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
      const recipientRegistration = await client.post<SessionRegistration>("/v1/sessions", {
        id: randomUUID(),
        provider: "claude-code",
        repository,
      });
      const senderRegistration = await client.post<SessionRegistration>("/v1/sessions", {
        id: randomUUID(),
        provider: "codex",
        repository: { ...repository, branch: "feature" },
      });
      const recipient = recipientRegistration.session;
      const sender = senderRegistration.session;
      await expect(
        client.get(`/v1/inbox?sessionId=${recipient.id}&unreadOnly=true`, senderRegistration.capability),
      ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
      const sent = await client.post<{ message: MessageRecord }>("/v1/messages", {
        senderSessionId: sender.id,
        to: recipient.address,
        body: "hello",
      }, senderRegistration.capability);
      const inbox = await client.get<MessageRecord[]>(
        `/v1/inbox?sessionId=${recipient.id}&unreadOnly=true`,
        recipientRegistration.capability,
      );
      expect(inbox[0]?.id).toBe(sent.message.id);
      expect(await client.get("/health")).toEqual({ ok: true, version: "test" });
    } finally {
      await daemon.close();
    }
  });

  it("rejects an incompatible protocol major with upgrade required", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const daemon = await startDaemon({ version: "test", paths });
    try {
      const secret = await readLocalSecret(paths);
      const result = await new Promise<{ status: number; protocol: string | undefined; body: string }>((resolve, reject) => {
        const req = request(
          {
            socketPath: paths.socket,
            path: "/health",
            headers: { authorization: `Bearer ${secret}`, "x-pinboard-protocol-version": "2" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => resolve({
              status: response.statusCode ?? 0,
              protocol: response.headers["x-pinboard-protocol-version"] as string | undefined,
              body: Buffer.concat(chunks).toString("utf8"),
            }));
          },
        );
        req.once("error", reject);
        req.end();
      });

      expect(result.status).toBe(426);
      expect(result.protocol).toBe("1");
      expect(JSON.parse(result.body)).toMatchObject({ error: { code: "PROTOCOL_VERSION_MISMATCH" } });
    } finally {
      await daemon.close();
    }
  });

  it("does not unlink an active socket when the secret no longer authenticates", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const daemon = await startDaemon({ version: "first", paths });
    const originalSecret = await readLocalSecret(paths);
    try {
      await rm(paths.lock, { force: true });
      let replacement = originalSecret;
      while (replacement === originalSecret) replacement = randomBytes(32).toString("base64url");
      await writeFile(paths.secret, `${replacement}\n`, "utf8");

      await expect(startDaemon({ version: "second", paths })).rejects.toThrow("already listening");
      expect(await exists(paths.socket)).toBe(true);

      await writeFile(paths.secret, `${originalSecret}\n`, "utf8");
      expect(await new DaemonClient(paths).get("/health")).toEqual({ ok: true, version: "first" });
    } finally {
      await daemon.close();
    }
  });

  it("holds an exclusive singleton lock and cleans up idempotently", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const daemon = await startDaemon({ version: "first", paths });
    expect(await exists(paths.lock)).toBe(true);
    await expect(startDaemon({ version: "second", paths })).rejects.toThrow("already running");

    await daemon.close();
    await daemon.close();
    expect(await exists(paths.lock)).toBe(false);
    expect(await exists(paths.pid)).toBe(false);
    if (process.platform !== "win32") expect(await exists(paths.socket)).toBe(false);
  });

  it("fails closed without deleting daemon state when lifecycle authentication fails", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    const daemon = await startDaemon({ version: "first", paths });
    const originalSecret = await readLocalSecret(paths);
    try {
      await writeFile(paths.secret, `${randomBytes(32).toString("base64url")}\n`, "utf8");
      await expect(stopBackgroundDaemon(paths)).rejects.toMatchObject({ status: 401 });
      expect(await exists(paths.pid)).toBe(true);
      expect(await exists(paths.socket)).toBe(true);
    } finally {
      await writeFile(paths.secret, `${originalSecret}\n`, "utf8");
      await daemon.close();
    }
  });
});
