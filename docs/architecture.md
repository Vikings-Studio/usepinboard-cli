# Local Architecture

Pinboard ships one npm package with three runtime roles:

```text
provider MCP process ─┐
provider hook process ├── authenticated local IPC ── pinboardd ── SQLite
pinboard CLI ─────────┘
```

The daemon is the only stateful process and SQLite writer. CLI, MCP, and hook processes are short-lived clients. Every MCP process registers a distinct session, which preserves provider/session attribution without trusting model-supplied identity.

## Local IPC

macOS and Linux use a Unix socket. Windows uses a named pipe. A random 256-bit bearer secret stored in a user-only runtime directory authenticates every request. Socket permissions are restricted where supported.

Each registered provider session also receives a 256-bit capability. The daemon stores only its hash and requires it for operations performed as that session. Long-lived MCP processes receive random capabilities. Repeated short-lived hook events derive a stable capability using HMAC-SHA-256 over the local secret and session ID, preventing concurrent hook processes from invalidating one another without persisting raw authority. The daemon secret protects the IPC endpoint; the session capability limits accidental identity confusion between connected providers.

## Provider and service lifecycle

Codex presence follows the supported MCP process lifecycle. Claude Code additionally uses user-scoped command hooks for lifecycle activity, safe-point inbox delivery, and advisory pre-edit lease context. Hook failures are fail-open and wake/resume is never inferred.

On macOS, `pinboard init` installs a per-user launchd agent. On Linux it installs a systemd user service. Definitions invoke absolute Node and packaged CLI paths without a shell, carry no inherited secrets, and are replaced or removed only when the Pinboard ownership marker is present. Windows uses the authenticated detached daemon path and remains beta.

## Persistence

Node's built-in `node:sqlite` provides a synchronous SQLite API with WAL mode and foreign keys. The API remains release-candidate in Node 24, so all database usage is isolated in `PinboardDatabase` and covered by migration and end-to-end tests.

## Product boundary

The package implements local Personal behavior only. Cloud relay, WorkOS organizations, billing, repository authorization, and cross-user policies belong to the separate Pinboard backend and must use versioned protocol contracts.
