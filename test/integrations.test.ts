import { describe, expect, it } from "vitest";
import { providerMcpInvocation } from "../src/integrations/detect.js";

describe("provider MCP configuration", () => {
  it("uses Claude Code user scope and no shell interpolation", () => {
    expect(providerMcpInvocation("claude-code")).toEqual({
      command: "claude",
      args: ["mcp", "add", "--scope", "user", "pinboard", "--", "pinboard", "mcp", "--provider", "claude-code"],
      display: "claude mcp add --scope user pinboard -- pinboard mcp --provider claude-code",
    });
  });

  it("uses the Codex MCP launcher contract", () => {
    expect(providerMcpInvocation("codex").args).toEqual([
      "mcp", "add", "pinboard", "--", "pinboard", "mcp", "--provider", "codex",
    ]);
  });
});
