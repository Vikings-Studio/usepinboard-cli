# Roadmap

The roadmap is ordered by evidence, not feature count.

## Personal foundation

- [x] Open-source repository, package, CI, and security baseline.
- [x] Local daemon, SQLite schema, authenticated IPC, presence, messaging, leases, and MCP tools.
- [ ] Clean-profile Claude Code integration tests.
- [ ] Clean-profile Codex integration tests and version-gated hook probes.
- [x] Idempotent, reversible provider installers.
- [x] launchd and systemd user-service implementation with ownership guards.
- [ ] Automated packed macOS launchd lifecycle canary (manual local canary passed on 2026-08-09).
- [ ] macOS and Linux package canaries.
- [ ] Useful-handoff instrumentation with explicit opt-in.

## Teams validation spike

- [x] WorkOS device-authenticated client, explicit repository links, and durable one-shot synchronization.
- [x] Stateless Mongo-backed relay for private-beta validation.
- [ ] Cross-user presence and messaging on separate machines.
- [ ] Measure messages sent, replied to, and acted on.
- [ ] Stop or revise if cross-user communication is not materially useful.

## Teams platform

- [x] WorkOS-backed organizations, membership projection, and devices. Invitations remain managed in WorkOS.
- [x] Durable offline delivery and receipts through explicit synchronization.
- [x] Organization-scoped repository linking and relay authorization.
- [ ] Human delivery policies: auto, notify, approve.
- [ ] Team-wide advisory leases and lightweight audit visibility.
- [ ] Teams billing at $10 per developer/month.

## Deferred until validated

- Wake/resume support.
- Broadcast messaging.
- Semantic relevance and knowledge routing.
- Enterprise controls and self-hosted relay.
- A2A compatibility edge.
