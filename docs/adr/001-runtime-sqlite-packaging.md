# ADR-001: Runtime, SQLite, packaging, and OS support

- Status: Accepted
- Date: 2026-08-09

## Context

Pinboard must install globally without a second runtime or native addon compilation. It needs durable local state, deterministic packaging, and a support boundary that matches what the project can continuously verify.

Node 24 includes `node:sqlite`, but the API is still marked Stability 1.2 (release candidate). Shipping it is an explicit maturity tradeoff, not a claim that the API is stable.

## Decision

- Require Node.js 24.15.0 or newer and test that exact floor in CI.
- Use ESM TypeScript compiled with `tsc`; publish declarations and source maps.
- Use built-in `node:sqlite` behind the `PinboardDatabase` adapter. Only the daemon opens the database for writes.
- Enable WAL, foreign keys, explicit schema migrations, transactions for multi-row state changes, and crash/replay tests.
- Ship one package, `@usepinboard/cli`, with the `pinboard` executable. CLI, daemon, hook, and MCP roles are entry modes of that package, not separately versioned packages.
- Keep runtime dependencies free of native addons.
- Treat macOS and Linux as the initial GA platforms. Keep Windows named-pipe and CI coverage, but label Windows best-effort until lifecycle installation and credential ACLs have dedicated integration tests.
- Publish through npm trusted publishing with provenance. A GitHub release tag must exactly match `package.json`.

## Consequences

The package is larger than a bundled single-file executable but remains inspectable and reproducible. A Node runtime is required. If a supported Node patch breaks the used SQLite surface, Pinboard pins the last verified patch and may introduce a reviewed `better-sqlite3` adapter; native fallback is not shipped pre-emptively.
