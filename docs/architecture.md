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

## Persistence

Node's built-in `node:sqlite` provides a synchronous SQLite API with WAL mode and foreign keys. The API remains release-candidate in Node 24, so all database usage is isolated in `PinboardDatabase` and covered by migration and end-to-end tests.

## Product boundary

The package implements local Personal behavior only. Cloud relay, WorkOS organizations, billing, repository authorization, and cross-user policies belong to the separate Pinboard backend and must use versioned protocol contracts.
