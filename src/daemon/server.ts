import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { chmod, unlink, writeFile, rm } from "node:fs/promises";
import { platform } from "node:os";
import { z } from "zod";
import { ERROR_CODES, MAX_REQUEST_BYTES, PROTOCOL_VERSION } from "../constants.js";
import { acquireDaemonLock } from "./lock.js";
import type { ApiErrorBody } from "../domain/types.js";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";
import { heartbeatSchema, leaseSchema, sendMessageSchema, sessionSchema } from "../protocol/schemas.js";
import { PROTOCOL_VERSION_HEADER, checkProtocolCompatibility } from "../protocol/version.js";
import { readOrCreateLocalSecret, verifyBearer } from "../security/local-auth.js";
import {
  deriveSessionCapability,
  generateSessionCapability,
  hashSessionCapability,
  SESSION_CAPABILITY_HEADER,
} from "../security/session-capability.js";
import { PinboardDatabase } from "../storage/database.js";

export interface DaemonHandle {
  close: () => Promise<void>;
  paths: PinboardPaths;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
  });
  response.end(data);
}

function apiError(response: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  json(response, status, body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function segment(pathname: string, index: number): string | undefined {
  return pathname.split("/").filter(Boolean)[index];
}

function safeMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join("; ");
  if (error instanceof SyntaxError) return "Request body must be valid JSON";
  if (error instanceof Error) return error.message;
  return "Unexpected local daemon error";
}

async function endpointIsOccupied(paths: PinboardPaths): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(paths.socket);
    let settled = false;
    const finish = (occupied: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(500, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(!["ECONNREFUSED", "ENOENT"].includes(error.code ?? ""));
    });
  });
}

export async function startDaemon(options: {
  version: string;
  paths?: PinboardPaths;
  foreground?: boolean;
}): Promise<DaemonHandle> {
  const paths = options.paths ?? getPaths();
  await ensureDirectories(paths);
  const secret = await readOrCreateLocalSecret(paths);

  const daemonLock = await acquireDaemonLock(paths, () => endpointIsOccupied(paths));

  if (await endpointIsOccupied(paths)) {
    await daemonLock.release();
    throw new Error(`A Pinboard daemon is already listening at ${paths.socket}`);
  }

  let database: PinboardDatabase | undefined;

  try {
    database = await PinboardDatabase.open(paths);
  } catch (error) {
    await daemonLock.release();
    throw error;
  }
  const startedAt = Date.now();

  // The callback contains its own request-level error boundary below.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createServer(async (request, response) => {
    if (!verifyBearer(request.headers.authorization, secret)) {
      apiError(response, 401, ERROR_CODES.unauthorized, "Local daemon authorization failed");
      return;
    }

    const protocol = checkProtocolCompatibility(request.headers[PROTOCOL_VERSION_HEADER]);
    if (!protocol.compatible) {
      apiError(
        response,
        426,
        ERROR_CODES.protocolVersionMismatch,
        `Pinboard protocol v${protocol.expected} is required; received ${protocol.received ?? "no valid version"}`,
      );
      return;
    }

    const rawCapability = request.headers[SESSION_CAPABILITY_HEADER];
    const sessionCapability = Array.isArray(rawCapability) ? rawCapability[0] : rawCapability;
    const requireSessionCapability = (sessionId: string): boolean => {
      if (database.sessionCapabilityMatches(sessionId, sessionCapability)) return true;
      apiError(response, 403, ERROR_CODES.forbidden, "A valid capability for this session is required");
      return false;
    };

    try {
      const url = new URL(request.url ?? "/", "http://pinboard.local");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, version: options.version });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/status") {
        json(response, 200, database.status(options.version, startedAt));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/export") {
        json(response, 200, database.exportSnapshot());
        return;
      }
      if (method === "POST" && url.pathname === "/v1/sessions") {
        const input = sessionSchema.parse(await readJson(request));
        const capability = input.providerSessionId
          ? deriveSessionCapability(secret, input.id)
          : generateSessionCapability();
        json(
          response,
          201,
          {
            session: database.registerSession({
              id: input.id,
              provider: input.provider,
              repository: input.repository,
              ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
              ...(input.taskLabel === undefined ? {} : { taskLabel: input.taskLabel }),
              ...(input.pid === undefined ? {} : { pid: input.pid }),
            }, hashSessionCapability(capability)),
            capability,
          },
        );
        return;
      }
      if (method === "POST" && /^\/v1\/sessions\/[^/]+\/heartbeat$/u.test(url.pathname)) {
        const id = segment(url.pathname, 2);
        if (!id) throw new Error("Session ID is required");
        if (!requireSessionCapability(id)) return;
        const body = heartbeatSchema.parse(await readJson(request));
        json(response, 200, database.heartbeat(id, body.taskLabel));
        return;
      }
      if (method === "POST" && /^\/v1\/sessions\/[^/]+\/end$/u.test(url.pathname)) {
        const id = segment(url.pathname, 2);
        if (!id) throw new Error("Session ID is required");
        if (!requireSessionCapability(id)) return;
        database.endSession(id);
        json(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/presence") {
        const repositoryIdentity = url.searchParams.get("repo") ?? undefined;
        const branch = url.searchParams.get("branch") ?? undefined;
        json(
          response,
          200,
          database.listPresence({
            ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
            ...(branch === undefined ? {} : { branch }),
            includeIdle: url.searchParams.get("includeIdle") === "true",
            includeStale: url.searchParams.get("includeStale") === "true",
          }),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/v1/messages") {
        const input = sendMessageSchema.parse(await readJson(request));
        if (input.senderSessionId && !requireSessionCapability(input.senderSessionId)) return;
        json(
          response,
          201,
          database.sendMessage({
            to: input.to,
            body: input.body,
            ...(input.senderSessionId === undefined ? {} : { senderSessionId: input.senderSessionId }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/v1/inbox") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) throw new Error("sessionId is required");
        if (!requireSessionCapability(sessionId)) return;
        json(
          response,
          200,
          database.inbox({
            sessionId,
            unreadOnly: url.searchParams.get("unreadOnly") === "true",
            queuedOnly: url.searchParams.get("queuedOnly") === "true",
            limit: Number(url.searchParams.get("limit") ?? 20),
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/v1/threads") {
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
        if (sessionId && !requireSessionCapability(sessionId)) return;
        json(
          response,
          200,
          database.listThreads({
            ...(sessionId === undefined ? {} : { sessionId }),
            limit: Number(url.searchParams.get("limit") ?? 20),
          }),
        );
        return;
      }
      if (method === "POST" && /^\/v1\/messages\/[^/]+\/read$/u.test(url.pathname)) {
        const messageId = segment(url.pathname, 2);
        const body = z.object({ sessionId: z.uuid() }).parse(await readJson(request));
        if (!messageId) throw new Error("Message ID is required");
        if (!requireSessionCapability(body.sessionId)) return;
        database.markRead(messageId, body.sessionId);
        json(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/leases") {
        const input = leaseSchema.parse(await readJson(request));
        if (!requireSessionCapability(input.sessionId)) return;
        json(
          response,
          201,
          database.createLease({
            sessionId: input.sessionId,
            paths: input.paths,
            ttlMinutes: input.ttlMinutes,
            ...(input.note === undefined ? {} : { note: input.note }),
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/v1/leases") {
        json(response, 200, database.listLeases(url.searchParams.get("repo") ?? undefined));
        return;
      }
      if (method === "DELETE" && /^\/v1\/leases\/[^/]+$/u.test(url.pathname)) {
        const leaseId = segment(url.pathname, 2);
        if (!leaseId) throw new Error("Lease ID is required");
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) throw new Error("sessionId is required to release a lease");
        if (!requireSessionCapability(sessionId)) return;
        const released = database.releaseLease(leaseId, sessionId);
        if (!released) {
          apiError(response, 404, ERROR_CODES.notFound, "Active lease was not found");
          return;
        }
        json(response, 200, { ok: true });
        return;
      }

      apiError(response, 404, ERROR_CODES.notFound, "Local endpoint was not found");
    } catch (error) {
      const message = safeMessage(error);
      const isMissing = /was not found|No active session matches/u.test(message);
      apiError(
        response,
        isMissing ? 404 : 400,
        isMissing ? ERROR_CODES.notFound : ERROR_CODES.invalidInput,
        message,
      );
    }
  });

  let ownsPid = false;
  try {
    if (platform() !== "win32") {
      await unlink(paths.socket).catch((error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      });
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => resolve());
    });

    if (platform() !== "win32") await chmod(paths.socket, 0o600);
    await writeFile(paths.pid, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    ownsPid = true;
  } catch (error) {
    const cleanupErrors: unknown[] = [error];
    const ownsSocket = server.listening;
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((cleanupError) => (cleanupError ? reject(cleanupError) : resolve()));
      }).catch((cleanupError: unknown) => {
        cleanupErrors.push(cleanupError);
      });
    }
    try {
      database.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const ownedPaths = [
      ...(ownsPid ? [paths.pid] : []),
      ...(ownsSocket && platform() !== "win32" ? [paths.socket] : []),
    ];
    for (const path of ownedPaths) {
      try {
        await rm(path, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await daemonLock.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Pinboard daemon startup cleanup failed");
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      const cleanupErrors: unknown[] = [];
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        try {
          database.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        for (const path of platform() === "win32" ? [paths.pid] : [paths.pid, paths.socket]) {
          try {
            await rm(path, { force: true });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await daemonLock.release();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Pinboard daemon cleanup failed");
    })();
    return closePromise;
  };

  return { close, paths };
}
