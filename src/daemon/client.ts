import { request } from "node:http";
import { ERROR_CODES, PROTOCOL_VERSION } from "../constants.js";
import type { ApiErrorBody } from "../domain/types.js";
import { getPaths, type PinboardPaths } from "../platform/paths.js";
import { PROTOCOL_VERSION_HEADER, parseProtocolVersion } from "../protocol/version.js";
import { InvalidLocalSecretError, readLocalSecret } from "../security/local-auth.js";

export class DaemonClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "DaemonClientError";
    this.code = code;
    this.status = status;
  }
}

export class DaemonClient {
  readonly paths: PinboardPaths;

  constructor(paths: PinboardPaths = getPaths()) {
    this.paths = paths;
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>("POST", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.call<T>("DELETE", path);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let secret: string;
    try {
      secret = await readLocalSecret(this.paths);
    } catch (error) {
      if (error instanceof InvalidLocalSecretError) {
        throw new DaemonClientError(error.message, ERROR_CODES.unauthorized, 401);
      }
      throw new DaemonClientError(
        "Pinboard is not initialized. Run `pinboard init`.",
        ERROR_CODES.daemonUnavailable,
        503,
      );
    }

    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.paths.socket,
          path,
          method,
          headers: {
            authorization: `Bearer ${secret}`,
            accept: "application/json",
            [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(payload)),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const daemonProtocol = parseProtocolVersion(response.headers[PROTOCOL_VERSION_HEADER]);
            if (daemonProtocol !== PROTOCOL_VERSION) {
              reject(
                new DaemonClientError(
                  `Pinboard protocol mismatch: client v${PROTOCOL_VERSION}, daemon ${daemonProtocol === null ? "unknown" : `v${daemonProtocol}`}`,
                  ERROR_CODES.protocolVersionMismatch,
                  426,
                ),
              );
              return;
            }
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = raw ? (JSON.parse(raw) as unknown) : null;
            } catch {
              reject(new DaemonClientError("Daemon returned invalid JSON", ERROR_CODES.internal, response.statusCode ?? 500));
              return;
            }
            if ((response.statusCode ?? 500) >= 400) {
              const failure = parsed as ApiErrorBody;
              reject(
                new DaemonClientError(
                  failure.error.message,
                  failure.error.code,
                  response.statusCode ?? 500,
                ),
              );
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          new DaemonClientError(
            `Pinboard daemon is unavailable (${error.code ?? "connection failed"}). Run \`pinboard daemon start\`.`,
            ERROR_CODES.daemonUnavailable,
            503,
          ),
        );
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
