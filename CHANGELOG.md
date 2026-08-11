# Changelog

All notable changes will be documented here. This project follows Semantic Versioning after `1.0.0` and uses prerelease versions before then.

## 0.1.0-beta.1 — Release candidate (2026-08-11)

This candidate is ready for the first npm beta publish but has not been published yet.

- Initial open-source Personal foundation.
- Local daemon with authenticated IPC and SQLite persistence.
- Presence, targeted messaging, inboxes, and advisory leases.
- MCP and CLI surfaces.
- Reversible Claude Code hooks and exact-owner MCP reconciliation for Claude Code and Codex.
- Native launchd and systemd user services with transactional rollback and guarded upgrades.
- Versioned configuration, local export/purge, uninstall/update handoffs, and legacy-data adoption checks.
- Packaged acceptance coverage for delivery, replies, history, leases, and session end signals.
- Open-source governance, security, CI, and release foundations.
- WorkOS device authorization, organization-scoped repository adoption, cloud discovery, and durable manual Teams synchronization.
- Canonical `team/<userId>` discovery addresses accepted directly by `pinboard send`.
- Removal of the obsolete static-token cloud connection path; Teams credentials now use only the operating system credential store.
