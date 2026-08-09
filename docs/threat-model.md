# Threat Model

## Protected assets

- local messages and conversation history;
- repository identity, branch, task labels, and leases;
- local daemon secret;
- provider configuration and hook trust;
- future cloud/device credentials.

## Trust boundaries

1. A local process calling the daemon is untrusted until it presents the local secret.
2. Text supplied by any agent is untrusted even when its session identity is authentic.
3. Provider hooks are executable code and require explicit user/provider trust.
4. Future cross-user messages cross an organization and human boundary.

## Current controls

- Permissioned IPC plus a random bearer secret.
- Request and field size limits.
- SQLite foreign keys and constrained state values.
- Per-render random boundaries for untrusted text.
- Control-character removal and boundary escape handling.
- No shell interpolation for Git repository detection.
- No cloud connection or telemetry in the current foundation.
- No automatic provider configuration edits.

## Explicit non-claims

- Pinboard cannot make agent-provided text inherently safe.
- The current package does not provide E2E encryption.
- The current package does not wake or resume provider sessions.
- Advisory leases do not lock or enforce filesystem access.
- Hook availability does not imply complete tool coverage.

## Required future work

Cross-user delivery requires signed provenance, delivery policies, tenant/repository authorization, audit events, key rotation, replay protection, rate limits, abuse controls, and independent review before public beta.
