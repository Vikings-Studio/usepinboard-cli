# Provider compatibility

This document describes implemented, test-backed behavior. A detected executable alone never upgrades an unsupported capability to supported.

| Capability | Claude Code | Codex |
| --- | --- | --- |
| MCP tools | Supported through the provider MCP launcher | Supported through the provider MCP launcher |
| Presence | MCP lifecycle; Claude hooks add lifecycle activity | MCP process lifecycle |
| Inbox pull | MCP tool | MCP tool |
| Safe-point delivery | UserPromptSubmit, PostToolUse, and Stop hooks when installed | Unsupported |
| Advisory pre-edit lease context | PreToolUse for supported edit tools when hooks are installed | Unsupported |
| Wake or resume | Unsupported | Unsupported |
| Session-end signal | Claude SessionEnd hook plus MCP process signals | MCP process signals |

Pinboard installs Claude hooks in the user-scoped `~/.claude/settings.json`, preserving unrelated configuration and making a restrictive backup before mutation. Removal matches only enumerated Pinboard command signatures. Codex hook support is not enabled from undocumented version guesses; MCP remains its verified integration surface.

Run `pinboard doctor --json` or `pinboard integrations doctor --json` on the exact installed provider versions for the local capability matrix.
