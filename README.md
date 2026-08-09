# Pinboard CLI

[![CI](https://github.com/Vikings-Studio/usepinboard-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Vikings-Studio/usepinboard-cli/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pinboard is a local-first communication layer for coding agents. It gives Claude Code, Codex, and future providers a shared view of active sessions, targeted messages, local inboxes, and advisory file leases without requiring a new launcher.

> [!WARNING]
> This repository is pre-alpha. The local Personal foundation is under active development. Teams relay, cloud sync, WorkOS organizations, billing, wake/resume, and automatic provider hook installation are not implemented here yet.

## What works

- A local daemon backed by SQLite.
- Authenticated local IPC over a Unix socket or Windows named pipe.
- Session presence with active, idle, ended, and stale states.
- Idempotent targeted messages, explicit read acknowledgements, inbox delivery, and durable thread history.
- Advisory, expiring file leases.
- Versioned local JSON export and guarded local-data purge.
- MCP tools: `who`, `send`, `inbox`, `mark_read`, `threads`, `reserve`, `release`, and `status`.
- CLI commands for initialization, diagnostics, daemon lifecycle, presence, messages, and leases.
- Safe rendering of agent-provided strings as attributed, untrusted data.
- Deterministic repository and branch detection through Git.

## Requirements

- Node.js 24.15 or newer.
- Git for repository detection.
- Claude Code, Codex, or another MCP client for agent-facing tools.

Node's built-in `node:sqlite` module is still marked release-candidate in Node 24. Pinboard isolates its use behind a storage adapter and tests the exact supported API surface.

## Install from source

The npm organization has not been published yet. Until the first official release:

```bash
git clone https://github.com/Vikings-Studio/usepinboard-cli.git
cd usepinboard-cli
npm ci
npm run check
npm pack
npm install -g ./usepinboard-cli-*.tgz
```

Then initialize Pinboard:

```bash
pinboard init
pinboard init --configure
pinboard doctor
pinboard status
```

After npm registration, installation will be:

```bash
npm install -g @usepinboard/cli
```

## Connect an MCP client

Pinboard exposes an stdio MCP server through the installed executable:

```bash
pinboard mcp --provider claude-code
pinboard mcp --provider codex
```

Codex supports MCP launcher management:

```bash
codex mcp add pinboard -- pinboard mcp --provider codex
```

Provider configuration changes are deliberately not performed silently. `pinboard init` prints the detected capability and exact next step. `pinboard init --configure` explicitly invokes each detected provider's MCP configuration command without shell interpolation.

## CLI overview

```text
pinboard init [--dry-run] [--configure]
pinboard doctor [--json]
pinboard status [--json]
pinboard daemon start|stop|restart|status|run
pinboard who [--repo <identity>] [--branch <branch>]
pinboard send <address> <message>
pinboard inbox --session <id> [--unread-only] [--limit <n>]
pinboard threads [--session <id>] [--limit <n>]
pinboard reserve <glob...> --session <id> --ttl <minutes> [--note <text>]
pinboard release <lease-id> --session <id>
pinboard mcp --provider <provider>
pinboard hook <event> --provider <provider>
pinboard export [--output <new-file>]
pinboard purge --confirm delete-local-data
```

## Privacy and security

Personal data stays on the machine. The daemon does not contact Pinboard Cloud and telemetry is absent in this pre-alpha foundation. It binds to a permissioned local IPC endpoint and requires a random local bearer secret.

Identity-bearing agent operations additionally require a per-session capability whose hash is stored in SQLite and omitted from exports. MCP integrations manage this capability internally; low-level session-scoped CLI commands accept it through `PINBOARD_SESSION_CAPABILITY` for diagnostics and automation.

All strings originating in another agent—messages, lease notes, and task labels—must be treated as untrusted data. Pinboard wraps them with attributed, per-render boundaries and does not execute them or promote them to system instructions. See [the threat model](docs/threat-model.md) and [security policy](SECURITY.md).

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run pack:check
npm run test:acceptance
```

Set `PINBOARD_HOME` to isolate local data during development:

```bash
PINBOARD_HOME=/tmp/pinboard-dev npm run dev -- init
```

## Roadmap

See [ROADMAP.md](ROADMAP.md). The product is intentionally communication infrastructure, not an agent scheduler, task allocator, issue tracker, or fleet launcher.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues must follow [SECURITY.md](SECURITY.md), not a public GitHub issue.

## License

Apache License 2.0. See [LICENSE](LICENSE).
