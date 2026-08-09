import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute } from "node:path";
import { claudeHooksConfigured, claudeSettingsPath } from "./claude-hooks.js";

export interface ProviderDetection {
  id: "claude-code" | "codex";
  installed: boolean;
  version: string | null;
  mcpConfigured: boolean;
  mcpVerified: boolean;
  mcpOwned: boolean;
  mcpCommand: string;
  hookSupport: "configured-unverified" | "supported-unconfigured" | "blocked-by-policy" | "mcp-session-lifecycle" | "not-detected";
  capabilities: {
    presence: "mcp-lifecycle" | "claude-hooks" | "unavailable";
    safePointDelivery: boolean;
    wake: false;
  };
  capabilityMatrix: {
    presence: CapabilityEvidence;
    safePointDelivery: CapabilityEvidence;
    preEditLeases: CapabilityEvidence;
    wake: CapabilityEvidence;
  };
}

export interface CapabilityEvidence {
  configured: boolean;
  runtimeVerified: boolean;
  source: "mcp-config" | "claude-user-settings" | "enterprise-policy" | "unsupported";
  reason: string;
  providerVersion: string | null;
}

export type ProviderId = ProviderDetection["id"];

interface McpExecutable {
  command: string;
  prefixArgs?: string[];
}

export function providerMcpInvocation(id: ProviderId, executable: McpExecutable = { command: "pinboard" }): { command: string; args: string[]; display: string } {
  const serverArgs = [...(executable.prefixArgs ?? []), "mcp", "--provider", id];
  if (id === "claude-code") {
    const args = ["mcp", "add", "--scope", "user", "pinboard", "--", executable.command, ...serverArgs];
    return { command: "claude", args, display: `claude ${args.join(" ")}` };
  }
  const args = ["mcp", "add", "pinboard", "--", executable.command, ...serverArgs];
  return { command: "codex", args, display: `codex ${args.join(" ")}` };
}

function currentMcpExecutable(): McpExecutable {
  const cliExecutable = process.argv[1];
  return cliExecutable?.endsWith(".js")
    ? { command: process.execPath, prefixArgs: [cliExecutable] }
    : { command: "pinboard" };
}

export function configureProviderMcp(id: ProviderId): void {
  const existing = mcpConfiguration(id);
  if (existing.verified) return;
  if (existing.configured) {
    if (!existing.owned) {
      throw new Error(`A non-Pinboard MCP entry named pinboard already exists in ${id}; it was preserved. Review and remove it manually before installing Pinboard.`);
    }
    removeProviderMcp(id, true);
  }
  try {
    addProviderMcp(id, currentMcpExecutable());
  } catch (error) {
    if (existing.executable) {
      try {
        addProviderMcp(id, existing.executable);
      } catch (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nThe previous Pinboard MCP entry could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    throw error;
  }
}

function addProviderMcp(id: ProviderId, executable: McpExecutable): void {
  const invocation = providerMcpInvocation(id, executable);
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", shell: false, stdio: "pipe", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "provider command failed").trim();
    throw new Error(`Could not configure ${id}: ${detail}`);
  }
}

export function removeProviderMcp(id: ProviderId, knownOwned = false): "removed" | "absent" | "preserved" {
  const command = id === "claude-code" ? "claude" : "codex";
  const existing = knownOwned ? { configured: true, verified: true, owned: true, executable: null } : mcpConfiguration(id);
  if (!existing.configured) return "absent";
  if (!knownOwned && !existing.owned) return "preserved";
  const args = id === "claude-code"
    ? ["mcp", "remove", "--scope", "user", "pinboard"]
    : ["mcp", "remove", "pinboard"];
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, stdio: "pipe", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "provider command failed").trim();
    throw new Error(`Could not remove Pinboard MCP from ${id}: ${detail}`);
  }
  return "removed";
}

function detect(command: string): { installed: boolean; version: string | null } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", shell: false, timeout: 3_000 });
  if (result.error || result.status !== 0) return { installed: false, version: null };
  return { installed: true, version: (result.stdout || result.stderr).trim() || "unknown" };
}

export function mcpOutputMatches(id: ProviderId, output: string, executable: McpExecutable = { command: "pinboard" }): boolean {
  const expectedArgs = [...(executable.prefixArgs ?? []), "mcp", "--provider", id];
  if (id === "codex") {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      const transport = parsed.transport && typeof parsed.transport === "object" && !Array.isArray(parsed.transport)
        ? parsed.transport as Record<string, unknown>
        : parsed;
      return transport.command === executable.command
        && Array.isArray(transport.args)
        && transport.args.join("\0") === expectedArgs.join("\0");
    } catch {
      return false;
    }
  }
  const normalized = output.replaceAll(/\s+/gu, " ");
  return normalized.includes("Scope: User config ")
    && normalized.includes(`Command: ${executable.command} `)
    && normalized.includes(`Args: ${expectedArgs.join(" ")} `);
}

function packagedCliPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return isAbsolute(value)
    && /\/(?:node_modules\/@usepinboard\/cli|usepinboard-cli)\/dist\/cli\.js$/u.test(normalized);
}

function absoluteNodePath(value: string): boolean {
  return isAbsolute(value) && /(?:^|[\\/])node(?:\.exe)?$/iu.test(value);
}

function ownedMcpExecutable(id: ProviderId, output: string): McpExecutable | null {
  if (id === "codex") {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      const transport = parsed.transport && typeof parsed.transport === "object" && !Array.isArray(parsed.transport)
        ? parsed.transport as Record<string, unknown>
        : parsed;
      const args = transport.args;
      if (transport.command === "pinboard" && Array.isArray(args) && args.join("\0") === "mcp\0--provider\0codex") return { command: "pinboard" };
      return typeof transport.command === "string" && absoluteNodePath(transport.command)
        && Array.isArray(args) && args.length === 4 && typeof args[0] === "string" && packagedCliPath(args[0])
        && args[1] === "mcp" && args[2] === "--provider" && args[3] === "codex"
        ? { command: transport.command, prefixArgs: [args[0]] }
        : null;
    } catch {
      return null;
    }
  }
  const scope = output.match(/^Scope:\s*(.+)$/mu)?.[1]?.trim();
  const command = output.match(/^Command:\s*(.+)$/mu)?.[1]?.trim();
  const args = output.match(/^Args:\s*(.+)$/mu)?.[1]?.trim();
  if (scope !== "User config" || !command || !args) return null;
  if (command === "pinboard" && args === "mcp --provider claude-code") return { command: "pinboard" };
  const suffix = " mcp --provider claude-code";
  const cliPath = args.endsWith(suffix) ? args.slice(0, -suffix.length) : "";
  return absoluteNodePath(command) && packagedCliPath(cliPath) ? { command, prefixArgs: [cliPath] } : null;
}

export function mcpOutputOwnedByPinboard(id: ProviderId, output: string): boolean {
  return ownedMcpExecutable(id, output) !== null;
}

function mcpConfiguration(id: ProviderId): { configured: boolean; verified: boolean; owned: boolean; executable: McpExecutable | null } {
  const command = id === "claude-code" ? "claude" : "codex";
  const args = id === "codex" ? ["mcp", "get", "pinboard", "--json"] : ["mcp", "get", "pinboard"];
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 3_000 });
  if (result.error || result.status !== 0) return { configured: false, verified: false, owned: false, executable: null };
  const output = id === "codex" ? result.stdout : `${result.stdout}\n${result.stderr}`;
  const verified = mcpOutputMatches(id, output, currentMcpExecutable());
  const executable = ownedMcpExecutable(id, output);
  return { configured: true, verified, owned: verified || executable !== null, executable };
}

function claudeUserHooksBlocked(): boolean {
  const current = platform();
  const path = current === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : current === "win32"
      ? `${process.env.ProgramFiles ?? "C:\\Program Files"}\\ClaudeCode\\managed-settings.json`
      : "/etc/claude-code/managed-settings.json";
  const policyValue = (policyPath: string): boolean | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
      const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).allowManagedHooksOnly
        : undefined;
      return typeof value === "boolean" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  let effective = policyValue(path);
  try {
    const dropInDirectory = path.replace(/managed-settings\.json$/u, "managed-settings.d");
    for (const entry of readdirSync(dropInDirectory).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort()) {
      effective = policyValue(`${dropInDirectory}/${entry}`) ?? effective;
    }
  } catch {
    // No managed-settings drop-in directory is the normal unmanaged case.
  }
  if (current === "darwin") {
    const managed = spawnSync("defaults", ["read", "/Library/Managed Preferences/com.anthropic.claudecode", "allowManagedHooksOnly"], { encoding: "utf8", shell: false, timeout: 3_000 });
    if (managed.status === 0) {
      if (/^(?:1|true|yes)$/iu.test(managed.stdout.trim())) return true;
      if (/^(?:0|false|no)$/iu.test(managed.stdout.trim())) return false;
    }
    return effective === true;
  } else if (current === "win32") {
    const registryPolicy = (key: string): boolean | undefined => {
      const managed = spawnSync("reg", ["query", key, "/v", "Settings"], { encoding: "utf8", shell: false, timeout: 3_000 });
      const serialized = managed.status === 0 ? managed.stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/imu)?.[1]?.trim() : undefined;
      if (serialized) {
        try {
          const parsed = JSON.parse(serialized) as { allowManagedHooksOnly?: unknown };
          return typeof parsed.allowManagedHooksOnly === "boolean" ? parsed.allowManagedHooksOnly : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    const machinePolicy = registryPolicy("HKLM\\SOFTWARE\\Policies\\ClaudeCode");
    if (machinePolicy !== undefined) return machinePolicy;
    if (effective !== undefined) return effective;
    return registryPolicy("HKCU\\SOFTWARE\\Policies\\ClaudeCode") === true;
  }
  return effective === true;
}

export function detectProviders(): ProviderDetection[] {
  const claude = detect("claude");
  const codex = detect("codex");
  const claudeMcp = claude.installed ? mcpConfiguration("claude-code") : { configured: false, verified: false, owned: false, executable: null };
  const codexMcp = codex.installed ? mcpConfiguration("codex") : { configured: false, verified: false, owned: false, executable: null };
  let claudeHooks = false;
  const claudeHooksBlocked = claudeUserHooksBlocked();
  try {
    const parsed = JSON.parse(readFileSync(claudeSettingsPath(), "utf8")) as unknown;
    claudeHooks = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && claudeHooksConfigured(parsed as Record<string, unknown>));
  } catch {
    claudeHooks = false;
  }
  return [
    {
      id: "claude-code",
      ...claude,
      mcpConfigured: claudeMcp.configured,
      mcpVerified: claudeMcp.verified,
      mcpOwned: claudeMcp.owned,
      mcpCommand: providerMcpInvocation("claude-code", currentMcpExecutable()).display,
      hookSupport: !claude.installed ? "not-detected" : claudeHooksBlocked ? "blocked-by-policy" : claudeHooks ? "configured-unverified" : "supported-unconfigured",
      capabilities: {
        presence: claudeHooks && !claudeHooksBlocked ? "claude-hooks" : claude.installed ? "mcp-lifecycle" : "unavailable",
        safePointDelivery: claudeHooks && !claudeHooksBlocked,
        wake: false,
      },
      capabilityMatrix: {
        presence: {
          configured: claudeMcp.verified || (claudeHooks && !claudeHooksBlocked),
          runtimeVerified: false,
          source: claudeHooksBlocked ? "enterprise-policy" : claudeHooks ? "claude-user-settings" : "mcp-config",
          reason: claudeHooksBlocked
            ? "Enterprise managed settings block user hooks; MCP lifecycle remains the fallback"
            : claudeHooks ? "Exact Pinboard MCP and hook entries are inspected locally; run a provider canary to verify execution" : "Configure MCP and Claude hooks",
          providerVersion: claude.version,
        },
        safePointDelivery: {
          configured: claudeHooks && !claudeHooksBlocked,
          runtimeVerified: false,
          source: claudeHooksBlocked ? "enterprise-policy" : "claude-user-settings",
          reason: claudeHooksBlocked ? "User hooks are blocked by enterprise policy" : "Configured events are inspected; exact-version runtime canary remains required",
          providerVersion: claude.version,
        },
        preEditLeases: {
          configured: claudeHooks && !claudeHooksBlocked,
          runtimeVerified: false,
          source: claudeHooksBlocked ? "enterprise-policy" : "claude-user-settings",
          reason: claudeHooksBlocked ? "User hooks are blocked by enterprise policy" : "Configured PreToolUse handler is inspected; exact-version runtime canary remains required",
          providerVersion: claude.version,
        },
        wake: {
          configured: false,
          runtimeVerified: false,
          source: "unsupported",
          reason: "Pinboard does not infer or emulate Claude wake/resume support",
          providerVersion: claude.version,
        },
      },
    },
    {
      id: "codex",
      ...codex,
      mcpConfigured: codexMcp.configured,
      mcpVerified: codexMcp.verified,
      mcpOwned: codexMcp.owned,
      mcpCommand: providerMcpInvocation("codex", currentMcpExecutable()).display,
      hookSupport: codex.installed ? "mcp-session-lifecycle" : "not-detected",
      capabilities: {
        presence: codex.installed ? "mcp-lifecycle" : "unavailable",
        safePointDelivery: false,
        wake: false,
      },
      capabilityMatrix: {
        presence: {
          configured: codexMcp.verified,
          runtimeVerified: false,
          source: "mcp-config",
          reason: "Exact MCP entry is inspected; exact-version runtime canary remains required",
          providerVersion: codex.version,
        },
        safePointDelivery: {
          configured: false,
          runtimeVerified: false,
          source: "unsupported",
          reason: "No supported Codex safe-point hook is enabled",
          providerVersion: codex.version,
        },
        preEditLeases: {
          configured: false,
          runtimeVerified: false,
          source: "unsupported",
          reason: "No supported Codex pre-edit hook is enabled",
          providerVersion: codex.version,
        },
        wake: {
          configured: false,
          runtimeVerified: false,
          source: "unsupported",
          reason: "Pinboard does not infer or emulate Codex wake/resume support",
          providerVersion: codex.version,
        },
      },
    },
  ];
}
