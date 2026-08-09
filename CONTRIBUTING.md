# Contributing

Thanks for helping make coding-agent communication safer and more useful.

## Before opening a change

- Search existing issues and discussions.
- Use an issue for behavior changes, new provider adapters, protocol changes, or security-sensitive work.
- Keep the product boundary: communication, presence, discovery, messaging, and advisory leases—not orchestration.
- Never include customer data, credentials, private prompts, repository contents, or production logs.

## Local setup

```bash
npm ci
npm run check
```

Use a disposable data directory during development:

```bash
export PINBOARD_HOME=/tmp/pinboard-contributor
npm run dev -- init
```

## Pull requests

- Keep each pull request focused.
- Add or update tests for every behavior change.
- Update README, roadmap, protocol documentation, and threat model when relevant.
- State user impact, compatibility impact, and validation performed.
- Do not add telemetry, networking, or new data collection without an explicit privacy design.
- Do not claim a provider capability without a clean-profile test on a pinned provider version.

By contributing, you agree that your contribution is licensed under Apache-2.0.
