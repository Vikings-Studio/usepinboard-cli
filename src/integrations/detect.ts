import { spawnSync } from "node:child_process";

export interface ProviderDetection {
  id: "claude-code" | "codex";
  installed: boolean;
  version: string | null;
  mcpCommand: string;
  hookSupport: "available-unverified" | "not-detected";
}

function detect(command: string): { installed: boolean; version: string | null } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return { installed: false, version: null };
  return { installed: true, version: (result.stdout || result.stderr).trim() || "unknown" };
}

export function detectProviders(): ProviderDetection[] {
  const claude = detect("claude");
  const codex = detect("codex");
  return [
    {
      id: "claude-code",
      ...claude,
      mcpCommand: "claude mcp add pinboard -- pinboard mcp --provider claude-code",
      hookSupport: claude.installed ? "available-unverified" : "not-detected",
    },
    {
      id: "codex",
      ...codex,
      mcpCommand: "codex mcp add pinboard -- pinboard mcp --provider codex",
      hookSupport: codex.installed ? "available-unverified" : "not-detected",
    },
  ];
}
