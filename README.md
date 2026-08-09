# Pinboard CLI

[![CI](https://github.com/Vikings-Studio/usepinboard-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Vikings-Studio/usepinboard-cli/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pinboard is a local-first communication layer for coding agents. It gives Claude Code, Codex, and future providers a shared view of active sessions, targeted messages, local inboxes, and advisory file leases without requiring a new launcher.

> [!WARNING]
> This repository is pre-alpha. The offline Personal runtime and reversible local integrations are implemented, but the package is not published. An explicitly connected, static-token Teams validation relay is experimental; WorkOS login, production organizations, billing, and provider wake/resume are not implemented here yet.

## What works

- A local daemon backed by SQLite.
- Authenticated local IPC over a Unix socket or Windows named pipe.
- Session presence with active, idle, ended, and stale states.
- Idempotent targeted messages, explicit read acknowledgements, inbox delivery, and durable thread history.
- Advisory, expiring file leases.
- Versioned local JSON export and guarded local-data purge.
- MCP tools: `who`, `send`, `inbox`, `mark_read`, `threads`, `reserve`, `release`, and `status`.
- CLI commands for initialization, diagnostics, daemon lifecycle, presence, messages, and leases.
- Idempotent MCP configuration for Claude Code and Codex, plus reversible Claude lifecycle, safe-point inbox, and advisory pre-edit hooks.
- Native per-user daemon definitions for launchd and systemd. Windows remains a documented best-effort manual-daemon beta.
- Versioned local configuration, package update handoff, and an uninstall flow that preserves data by default.
- Safe rendering of agent-provided strings as attributed, untrusted data.
- Deterministic repository and branch detection through Git.
- An opt-in design-partner relay client with durable one-shot synchronization, explicit repository links, and offline outbox/inbox state. It is not the production Teams authentication model.

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

Then initialize Pinboard and explicitly reconcile every detected provider:

```bash
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

Provider configuration changes are deliberately not performed silently. `pinboard init` prints the detected capability and exact next step. `pinboard init --configure` explicitly invokes each detected provider's MCP configuration command without shell interpolation and installs only documented Claude Code hooks. It creates a restrictive backup before changing Claude's user settings and preserves unrelated keys and hooks.

Claude Code receives queued messages at supported safe points (`UserPromptSubmit`, `PostToolUse`, and `Stop`) and sees advisory lease context before supported edit tools. A queued message is claimed once for automatic hook delivery and remains available through MCP until explicitly marked read. Codex uses its MCP process lifecycle for presence and must pull the inbox through MCP. Pinboard does not claim or emulate wake/resume on either provider.

## CLI overview

```text
pinboard init [--dry-run] [--configure]
pinboard doctor [--json]
pinboard status [--json]
pinboard daemon start|stop|restart|status|run
pinboard service install|uninstall|start|stop|restart|status
pinboard integrations list|install|remove|doctor
pinboard cloud connect --api <https-url>|status|disconnect
pinboard sync now|status|pause|resume
pinboard repo link --repository-id <allowed-id>|status|list|unlink
pinboard session end --id <session-id>
pinboard who [--repo <identity>] [--branch <branch>]
pinboard send <address> <message>
pinboard inbox --session <id> [--unread-only] [--limit <n>]
pinboard threads [--session <id>] [--limit <n>]
pinboard reserve <glob...> --session <id> --ttl <minutes> [--note <text>]
pinboard release <lease-id> --session <id>
pinboard mcp --provider <provider>
pinboard hook <provider>
pinboard config get|set|path
pinboard export [--output <new-file>]
pinboard purge --confirm delete-local-data
pinboard update [--dry-run]
pinboard uninstall [--purge-data --confirm delete-local-data]
```

## Experimental Teams validation relay

Personal never contacts Pinboard Cloud unless a user explicitly connects the validation relay. Static design-partner tokens are accepted only on standard input: they cannot be passed as command arguments or environment options and are never printed, exported, or included in diagnostics.

The experimental connection is macOS/Linux-only. Windows Personal remains supported at its existing beta level, but cloud connection is refused until Windows Credential Manager or DPAPI protection is implemented.

```bash
your-secret-manager read pinboard-design-partner-token \
  | pinboard cloud connect --api https://relay.example.com
pinboard repo link --repository-id api
pinboard sync now
```

Only HTTPS relay URLs are accepted, except loopback HTTP used by tests. Repository linking uploads the normalized Git remote, repository name, branch, provider, provider session reference, and optional deterministic task label. It never uploads the local repository root, raw prompt, file contents, or local daemon credentials.

Synchronization is manual in this validation slice. Messages addressed to `team/<user-id>` are committed to the local SQLite outbox before network delivery. Inbox pages restart from the newest page on every sync and deduplicate by remote message ID, so reconnects do not skip messages. `pinboard cloud disconnect` preserves Personal data and refuses to strand pending work unless `--discard-pending` is explicit.

Each session sync reads at most 20 pages of 100 pending messages. The validation relay enforces a 1,000-message recipient pending quota and excludes read, expired, and other-device claimed messages, keeping the bound reachable; exceeding it is reported as a deferred session failure while outbox and receipt flushing continues. Local data export intentionally excludes the experimental cloud cache and queue tables; disconnect or retain the marked Pinboard data directory for recovery instead.

## Privacy and security

Personal data stays on the machine and Personal mode performs no network requests. The daemon contacts the experimental relay only after explicit `cloud connect`; telemetry remains absent. Local IPC uses a permissioned endpoint and a random local bearer secret.

Identity-bearing agent operations additionally require a per-session capability whose hash is stored in SQLite and omitted from exports. MCP integrations manage this capability internally; low-level session-scoped CLI commands accept it through `PINBOARD_SESSION_CAPABILITY` for diagnostics and automation.

Short-lived provider hooks use a stable HMAC-derived capability bound to the local secret and session ID. This prevents concurrent lifecycle events from rotating one another's authority while keeping the capability out of settings files, logs, and exports.

All strings originating in another agent—messages, lease notes, and task labels—must be treated as untrusted data. Pinboard wraps them with attributed, per-render boundaries and does not execute them or promote them to system instructions. See [the threat model](docs/threat-model.md) and [security policy](SECURITY.md).

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run pack:check
npm run pack:verify
npm run test:acceptance
```

Set `PINBOARD_HOME` to isolate local data during development:

```bash
PINBOARD_HOME=/tmp/pinboard-dev npm run dev -- init
```

## Roadmap

See [ROADMAP.md](ROADMAP.md). The product is intentionally communication infrastructure, not an agent scheduler, task allocator, issue tracker, or fleet launcher.

## Removing Pinboard

`pinboard uninstall` removes only Pinboard-owned MCP entries, Claude hook handlers, and the user service. Local data remains in place. Permanent deletion requires:

```bash
pinboard uninstall --purge-data --confirm delete-local-data
```

The CLI cannot safely remove its own globally installed package while running; finish with `npm uninstall -g @usepinboard/cli`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues must follow [SECURITY.md](SECURITY.md), not a public GitHub issue.

## License

Apache License 2.0. See [LICENSE](LICENSE).
