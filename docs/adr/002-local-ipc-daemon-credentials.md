# ADR-002: Local IPC, daemon lifecycle, and credentials

- Status: Accepted
- Date: 2026-08-09

## Context

Multiple short-lived provider and CLI processes need one durable local owner for presence, messages, and leases. A localhost port without authentication would expose agent traffic to any local process and can be reached accidentally from browser contexts.

## Decision

- Run one `pinboardd` daemon per OS user. It is the sole SQLite writer.
- Use a Unix-domain socket on macOS/Linux and a per-user named pipe on Windows. Do not bind a TCP listener by default.
- Authenticate every request with a random 256-bit local bearer secret. Store this local-only IPC secret in a `0700` application directory and `0600` file; compare it in constant time. Cloud refresh credentials are different secrets and must use the OS keychain.
- Restrict socket permissions to the current user where the platform supports it. Hash the username and application directory into the endpoint name to prevent collisions without exposing the username.
- Bound request bodies and validate all payloads before touching storage.
- Install lifecycle management through launchd on macOS and a systemd user unit on Linux. Windows scheduled-task support remains beta. Foreground mode remains available for tests and unsupported environments.
- `pinboard init` must show a change plan, back up provider configuration, install idempotently, start the service, and run a self-test. `pinboard integrations remove` and `pinboard uninstall` remove only Pinboard-owned entries and restore backups when safe.
- A PID file is never sufficient proof of ownership. Stop operations first authenticate to the daemon; stale or unauthenticated PID files are removed without signalling that PID.
- Never print local or cloud secrets. Logs contain request IDs and safe error codes, not message bodies or tokens.

## Consequences

A process already running as the same OS user can generally read that user's files, so this is user isolation rather than a sandbox boundary. Keychain-backed cloud credentials and device keys provide the stronger boundary needed for Teams. Service installation adds OS-specific code and clean-profile tests before GA.
