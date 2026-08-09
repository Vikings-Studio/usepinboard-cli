import { spawnSync } from "node:child_process";

export interface ProviderDetection {
  id: "claude-code" | "codex";
  installed: boolean;
  version: string | null;
  mcpConfigured: boolean;
  mcpCommand: string;
  hookSupport: "available-unverified" | "not-detected";
}

export type ProviderId = ProviderDetection["id"];

export function providerMcpInvocation(id: ProviderId): { command: string; args: string[]; display: string } {
  if (id === "claude-code") {
    const args = ["mcp", "add", "--scope", "user", "pinboard", "--", "pinboard", "mcp", "--provider", "claude-code"];
    return { command: "claude", args, display: `claude ${args.join(" ")}` };
  }
  const args = ["mcp", "add", "pinboard", "--", "pinboard", "mcp", "--provider", "codex"];
  return { command: "codex", args, display: `codex ${args.join(" ")}` };
}

export function configureProviderMcp(id: ProviderId): void {
  const invocation = providerMcpInvocation(id);
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", shell: false, stdio: "pipe" });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "provider command failed").trim();
    throw new Error(`Could not configure ${id}: ${detail}`);
  }
}

function detect(command: string): { installed: boolean; version: string | null } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return { installed: false, version: null };
  return { installed: true, version: (result.stdout || result.stderr).trim() || "unknown" };
}

function mcpConfigured(command: string): boolean {
  const result = spawnSync(command, ["mcp", "get", "pinboard"], { encoding: "utf8", shell: false });
  return !result.error && result.status === 0;
}

export function detectProviders(): ProviderDetection[] {
  const claude = detect("claude");
  const codex = detect("codex");
  return [
    {
      id: "claude-code",
      ...claude,
      mcpConfigured: claude.installed && mcpConfigured("claude"),
      mcpCommand: providerMcpInvocation("claude-code").display,
      hookSupport: claude.installed ? "available-unverified" : "not-detected",
    },
    {
      id: "codex",
      ...codex,
      mcpConfigured: codex.installed && mcpConfigured("codex"),
      mcpCommand: providerMcpInvocation("codex").display,
      hookSupport: codex.installed ? "available-unverified" : "not-detected",
    },
  ];
}
