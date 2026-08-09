import { describe, expect, it } from "vitest";
import { mcpOutputMatches, mcpOutputOwnedByPinboard, providerMcpInvocation } from "../src/integrations/detect.js";

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

  it("can pin provider launchers to an absolute Node and packaged CLI path", () => {
    expect(providerMcpInvocation("codex", { command: "/opt/node", prefixArgs: ["/opt/@usepinboard/cli/dist/cli.js"] }).args).toEqual([
      "mcp", "add", "pinboard", "--", "/opt/node", "/opt/@usepinboard/cli/dist/cli.js", "mcp", "--provider", "codex",
    ]);
  });

  it("verifies exact Claude and Codex MCP configurations", () => {
    expect(mcpOutputMatches("claude-code", "Scope: User config\nCommand: pinboard\nArgs: mcp --provider claude-code\n")).toBe(true);
    expect(mcpOutputMatches("claude-code", "Scope: Local config\nCommand: pinboard\nArgs: mcp --provider claude-code\n")).toBe(false);
    expect(mcpOutputMatches("codex", JSON.stringify({
      transport: { type: "stdio", command: "pinboard", args: ["mcp", "--provider", "codex"] },
    }))).toBe(true);
    expect(mcpOutputMatches("codex", JSON.stringify({
      transport: { type: "stdio", command: "pinboard", args: ["mcp", "--provider", "claude-code"] },
    }))).toBe(false);
    expect(mcpOutputMatches("codex", JSON.stringify({
      transport: { type: "stdio", command: "/opt/node", args: ["/opt/@usepinboard/cli/dist/cli.js", "mcp", "--provider", "codex"] },
    }), { command: "/opt/node", prefixArgs: ["/opt/@usepinboard/cli/dist/cli.js"] })).toBe(true);
  });

  it("recognizes only tightly shaped historical packaged Pinboard launchers", () => {
    expect(mcpOutputOwnedByPinboard("codex", JSON.stringify({
      transport: { command: "pinboard", args: ["mcp", "--provider", "codex"] },
    }))).toBe(true);
    expect(mcpOutputOwnedByPinboard("claude-code", "Scope: User config\nCommand: pinboard\nArgs: mcp --provider claude-code\n")).toBe(true);
    expect(mcpOutputOwnedByPinboard("codex", JSON.stringify({
      transport: { command: "/old/node", args: ["/old/node_modules/@usepinboard/cli/dist/cli.js", "mcp", "--provider", "codex"] },
    }))).toBe(true);
    expect(mcpOutputOwnedByPinboard("codex", JSON.stringify({
      transport: { command: "/old/node", args: ["/tmp/arbitrary.js", "mcp", "--provider", "codex"] },
    }))).toBe(false);
    expect(mcpOutputOwnedByPinboard("codex", JSON.stringify({
      transport: { command: "/old/node", args: ["/old/node_modules/@usepinboard/cli/dist/cli.js", "mcp", "--provider", "claude-code"] },
    }))).toBe(false);
    expect(mcpOutputOwnedByPinboard("claude-code", "Scope: User config\nCommand: /old/node\nArgs: /old/node_modules/@usepinboard/cli/dist/cli.js mcp --provider claude-code\n")).toBe(true);
    expect(mcpOutputOwnedByPinboard("claude-code", "Scope: Project config\nCommand: /old/node\nArgs: /old/node_modules/@usepinboard/cli/dist/cli.js mcp --provider claude-code\n")).toBe(false);
  });
});
