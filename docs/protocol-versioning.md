# Protocol versioning

Pinboard's local daemon API is versioned independently from the npm package.
The current protocol major is `1` and every supported endpoint is rooted at
`/v1`.

## Compatibility rules

- A protocol major is immutable after release. Breaking request, response, or
  delivery-semantic changes require a new `/vN` route family.
- Additive fields are allowed within a major. Clients must ignore response
  fields they do not understand.
- Existing fields cannot change type, meaning, requiredness, or nullability
  within a major.
- Enum values may be added only when clients already handle unknown values.
- The daemon returns `x-pinboard-protocol-version` on every JSON response.
- The client sends `x-pinboard-protocol-version` on every request. A daemon
  rejects a different major with `426 Upgrade Required` and the
  `PROTOCOL_VERSION_MISMATCH` error code.
- `/health` is deliberately unversioned so lifecycle code can identify an
  existing Pinboard daemon. It still participates in the version-header
  negotiation.

## Support window

The CLI and daemon distributed in one package must support the current protocol
major. When a future major ships, Pinboard will keep the prior major available
for at least one stable CLI release and document the migration before removing
it.

## Schema changes

Any protocol change must include:

1. updated Zod schemas and TypeScript types;
2. request/response compatibility tests;
3. an entry in the release notes;
4. a new ADR when it changes delivery, identity, authorization, or persistence
   semantics.
