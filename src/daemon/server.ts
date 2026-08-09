import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, unlink, writeFile, rm } from "node:fs/promises";
import { platform } from "node:os";
import { z } from "zod";
import { ERROR_CODES, MAX_REQUEST_BYTES } from "../constants.js";
import { DaemonClient } from "./client.js";
import type { ApiErrorBody } from "../domain/types.js";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";
import { heartbeatSchema, leaseSchema, sendMessageSchema, sessionSchema } from "../protocol/schemas.js";
import { readOrCreateLocalSecret, verifyBearer } from "../security/local-auth.js";
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

export async function startDaemon(options: {
  version: string;
  paths?: PinboardPaths;
  foreground?: boolean;
}): Promise<DaemonHandle> {
  const paths = options.paths ?? getPaths();
  await ensureDirectories(paths);
  const secret = await readOrCreateLocalSecret(paths);

  try {
    await new DaemonClient(paths).get("/health");
    throw new Error(`A Pinboard daemon is already listening at ${paths.socket}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("A Pinboard daemon is already")) throw error;
  }

  const database = await PinboardDatabase.open(paths);
  const startedAt = Date.now();

  if (platform() !== "win32") {
    await unlink(paths.socket).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    });
  }

  // The callback contains its own request-level error boundary below.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createServer(async (request, response) => {
    if (!verifyBearer(request.headers.authorization, secret)) {
      apiError(response, 401, ERROR_CODES.unauthorized, "Local daemon authorization failed");
      return;
    }

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
      if (method === "POST" && url.pathname === "/v1/sessions") {
        const input = sessionSchema.parse(await readJson(request));
        json(
          response,
          201,
          database.registerSession({
            id: input.id,
            provider: input.provider,
            repository: input.repository,
            ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
            ...(input.taskLabel === undefined ? {} : { taskLabel: input.taskLabel }),
            ...(input.pid === undefined ? {} : { pid: input.pid }),
          }),
        );
        return;
      }
      if (method === "POST" && /^\/v1\/sessions\/[^/]+\/heartbeat$/u.test(url.pathname)) {
        const id = segment(url.pathname, 2);
        if (!id) throw new Error("Session ID is required");
        const body = heartbeatSchema.parse(await readJson(request));
        json(response, 200, database.heartbeat(id, body.taskLabel));
        return;
      }
      if (method === "POST" && /^\/v1\/sessions\/[^/]+\/end$/u.test(url.pathname)) {
        const id = segment(url.pathname, 2);
        if (!id) throw new Error("Session ID is required");
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
        json(
          response,
          201,
          database.sendMessage({
            to: input.to,
            body: input.body,
            ...(input.senderSessionId === undefined ? {} : { senderSessionId: input.senderSessionId }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          }),
        );
        return;
      }
      if (method === "GET" && url.pathname === "/v1/inbox") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) throw new Error("sessionId is required");
        json(
          response,
          200,
          database.inbox({
            sessionId,
            unreadOnly: url.searchParams.get("unreadOnly") === "true",
            limit: Number(url.searchParams.get("limit") ?? 20),
          }),
        );
        return;
      }
      if (method === "POST" && /^\/v1\/messages\/[^/]+\/read$/u.test(url.pathname)) {
        const messageId = segment(url.pathname, 2);
        const body = z.object({ sessionId: z.uuid() }).parse(await readJson(request));
        if (!messageId) throw new Error("Message ID is required");
        database.markRead(messageId, body.sessionId);
        json(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/leases") {
        const input = leaseSchema.parse(await readJson(request));
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
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => resolve());
  });

  if (platform() !== "win32") await chmod(paths.socket, 0o600);
  await writeFile(paths.pid, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
    await rm(paths.pid, { force: true });
    if (platform() !== "win32") await rm(paths.socket, { force: true });
  };

  return { close, paths };
}
