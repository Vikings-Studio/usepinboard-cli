# Release and rollback runbook

The owner must confirm the `usepinboard` npm organization and trusted publisher before the first release. Agents must not publish or reserve the scope.

## Candidate verification

1. Use the minimum supported Node patch from `package.json`.
2. Run `npm ci`, `npm run check`, `npm run test:acceptance`, and `npm run pack:verify`.
3. Create the tarball with `npm pack` and globally install that exact file in an isolated profile.
4. Run `pinboard init --dry-run`, start the manual daemon in the isolated profile, and run `pinboard doctor --json`.
5. Verify macOS and Linux service canaries and both provider configuration contracts.
6. Confirm the release tag exactly matches a reviewed non-development package version.

Pre-release versions must publish under a non-default dist-tag such as `next`; `latest` is reserved for an approved stable release. Do not publish `0.0.0-development`.

## Rollback

Deprecate a bad npm version with an actionable replacement message; do not unpublish except within npm policy and only when necessary. Move the affected dist-tag to the last verified version, publish a GitHub advisory or release note, and keep the protocol compatible when possible. If local storage migration is involved, preserve exports and ship a forward repair migration rather than asking users to delete their database.
