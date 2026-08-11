# Threat Model

## Protected assets

- local messages and conversation history;
- repository identity, branch, task labels, and leases;
- local daemon secret;
- per-session capabilities;
- provider configuration and hook trust;
- scoped cloud device credentials and organization repository links.

## Trust boundaries

1. A local process calling the daemon is untrusted until it presents the local secret.
2. Identity-bearing operations additionally require the capability issued to that session.
3. Text supplied by any agent is untrusted even when its session identity is authentic.
4. Provider hooks are executable code and require explicit user/provider trust.
5. Cross-user messages cross an organization and human boundary and are untrusted even when their sender attribution is valid.

## Current controls

- Permissioned IPC plus a random bearer secret.
- Hashed per-session capabilities for identity-bearing operations; provider hooks derive stable capabilities through HMAC without persisting raw authority.
- Request and field size limits.
- SQLite foreign keys and constrained state values.
- Per-render random boundaries for untrusted text.
- Control-character removal and boundary escape handling.
- No shell interpolation for Git repository detection.
- No cloud connection or telemetry unless Teams is explicitly connected. WorkOS device authorization issues a scoped, expiring token that is kept in the operating system credential store, omitted from config/export/log output, and sent only to HTTPS or loopback endpoints without redirects. Static-token authentication is not supported.
- Teams requests derive organization, user, and device authority exclusively from the device token. The relay applies tenant and linked-repository authorization, recipient membership checks, bounded pagination, replay-safe mutation keys, rate limits, and attributed audit records.
- Cloud discovery returns a canonical user address while retaining session metadata. Messages are committed to the local outbox before delivery, pulled into a deduplicated inbox, and acknowledged with receipts during explicit synchronization.
- No silent provider configuration edits; `init --configure` is explicit opt-in.
- Claude settings mutations preserve unrelated values, reject symlinks and malformed JSON, back up before writes, and remove only enumerated Pinboard handlers.
- User-service definitions contain fixed absolute arguments, no shell interpolation or inherited secrets, restrictive umasks, ownership markers, and rollback on manager failure.
- Provider hooks fail open so a Pinboard outage cannot block the coding session.

## Explicit non-claims

- Pinboard cannot make agent-provided text inherently safe.
- The current package does not provide E2E encryption.
- The current package does not wake or resume provider sessions.
- Advisory leases do not lock or enforce filesystem access.
- Hook availability does not imply complete tool coverage.

## Required future work

Before public beta, add automated token renewal/revocation reconciliation, abuse operations, independent security review, and real two-user/multi-machine acceptance. Delivery policies, E2E encryption, wake/resume, and enterprise compliance remain explicit non-features.
