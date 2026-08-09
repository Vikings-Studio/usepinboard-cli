import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PinboardPaths } from "../platform/paths.js";

const OWNED_COMMAND = "pinboard hook claude-code";
const LEGACY_COMMANDS = new Set([
  OWNED_COMMAND,
  "pinboard hook SessionStart --provider claude-code",
  "pinboard hook UserPromptSubmit --provider claude-code",
  "pinboard hook PostToolBatch --provider claude-code",
  "pinboard hook Stop --provider claude-code",
  "pinboard hook SessionEnd --provider claude-code",
]);

interface CommandHook {
  type: "command";
  command: string;
  args?: string[];
  timeout: number;
}

export interface HookInvocation {
  command: string;
  args?: string[];
}

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
}

type JsonObject = Record<string, unknown>;

const REQUIRED_HOOKS: ReadonlyArray<{ event: string; matcher?: string; timeout: number }> = [
  { event: "SessionStart", matcher: "startup|resume|clear|compact|fork", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 2 },
  { event: "PostToolUse", matcher: "*", timeout: 2 },
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", timeout: 2 },
  { event: "Stop", timeout: 2 },
  { event: "SessionEnd", timeout: 5 },
];

export function claudeSettingsPath(home = homedir()): string {
  return join(home, ".claude", "settings.json");
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function group(value: unknown): HookGroup | null {
  const candidate = object(value);
  if (!candidate || !Array.isArray(candidate.hooks)) return null;
  return candidate as unknown as HookGroup;
}

export function providerHookInvocation(): HookInvocation {
  const cliExecutable = process.argv[1];
  if (cliExecutable?.endsWith(".js")) {
    return { command: process.execPath, args: [cliExecutable, "hook", "claude-code"] };
  }
  return { command: OWNED_COMMAND };
}

function isPackagedHookArgs(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === "string")) return false;
  const [cli, action, provider] = value;
  return action === "hook" && provider === "claude-code"
    && /(?:^|[\\/])(?:@usepinboard[\\/]cli|usepinboard-cli)[\\/]dist[\\/]cli\.js$/u.test(cli ?? "");
}

function sameInvocation(candidate: JsonObject, invocation: HookInvocation): boolean {
  const candidateArgs = Array.isArray(candidate.args) ? candidate.args : undefined;
  const expectedArgs = invocation.args;
  return candidate.command === invocation.command
    && (expectedArgs === undefined
      ? candidateArgs === undefined
      : candidateArgs?.join("\0") === expectedArgs.join("\0"));
}

function isOwnedHandler(value: unknown, current?: HookInvocation): boolean {
  const candidate = object(value);
  if (candidate?.type !== "command" || typeof candidate.command !== "string") return false;
  return LEGACY_COMMANDS.has(candidate.command)
    || isPackagedHookArgs(candidate.args)
    || Boolean(current && sameInvocation(candidate, current));
}

function canonicalHandler(timeout: number, invocation: HookInvocation): CommandHook {
  return { type: "command", command: invocation.command, ...(invocation.args ? { args: invocation.args } : {}), timeout };
}

function clone(value: JsonObject): JsonObject {
  return structuredClone(value);
}

export function installClaudeHooksInSettings(settings: JsonObject, invocation: HookInvocation = { command: OWNED_COMMAND }): { settings: JsonObject; changed: boolean } {
  const next = clone(settings);
  const hooks = object(next.hooks) ?? {};
  next.hooks = hooks;
  let changed = false;

  for (const required of REQUIRED_HOOKS) {
    const existing = Array.isArray(hooks[required.event]) ? hooks[required.event] as unknown[] : [];
    if (!Array.isArray(hooks[required.event])) {
      hooks[required.event] = existing;
      changed = true;
    }
    let target = existing.map(group).find((item) => item && (item.matcher ?? undefined) === required.matcher) ?? null;
    if (!target) {
      target = { ...(required.matcher ? { matcher: required.matcher } : {}), hooks: [] };
      existing.push(target);
      changed = true;
    }

    const withoutOwned = target.hooks.filter((item) => !isOwnedHandler(item, invocation));
    const canonicalExists = target.hooks.some((item) => {
      const candidate = object(item);
      return candidate?.type === "command" && sameInvocation(candidate, invocation) && candidate.timeout === required.timeout;
    });
    if (!canonicalExists || withoutOwned.length !== target.hooks.length - 1) {
      target.hooks = [...withoutOwned, canonicalHandler(required.timeout, invocation)];
      changed = true;
    }
  }
  return { settings: next, changed };
}

export function removeClaudeHooksFromSettings(settings: JsonObject, invocation?: HookInvocation): { settings: JsonObject; changed: boolean } {
  const next = clone(settings);
  const hooks = object(next.hooks);
  if (!hooks) return { settings: next, changed: false };
  let changed = false;
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue;
    const groups: unknown[] = [];
    for (const rawGroup of rawGroups as unknown[]) {
      const parsed = group(rawGroup);
      if (!parsed) {
        groups.push(rawGroup);
        continue;
      }
      const remaining = parsed.hooks.filter((item) => !isOwnedHandler(item, invocation));
      if (remaining.length !== parsed.hooks.length) changed = true;
      if (remaining.length > 0) groups.push({ ...parsed, hooks: remaining });
    }
    if (groups.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = groups;
  }
  if (Object.keys(hooks).length === 0) Reflect.deleteProperty(next, "hooks");
  return { settings: next, changed };
}

export function claudeHooksConfigured(settings: JsonObject, invocation: HookInvocation = providerHookInvocation()): boolean {
  const hooks = object(settings.hooks);
  if (!hooks) return false;
  return REQUIRED_HOOKS.every((required) => {
    const groups = hooks[required.event];
    return Array.isArray(groups) && groups.some((rawGroup) => {
      const parsed = group(rawGroup);
      if (!parsed || parsed.matcher !== required.matcher) return false;
      return parsed.hooks.some((item) => {
        const candidate = object(item);
        return candidate?.type === "command" && sameInvocation(candidate, invocation) && candidate.timeout === required.timeout;
      });
    });
  });
}

async function readSettings(path: string): Promise<{ value: JsonObject; mode: number }> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to edit symlinked Claude settings: ${path}`);
    if (!info.isFile()) throw new Error(`Claude settings path is not a regular file: ${path}`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const value = object(parsed);
    if (!value) throw new Error("Claude settings must contain a JSON object");
    return { value, mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, mode: 0o600 };
    if (error instanceof SyntaxError) throw new Error(`Claude settings are not valid JSON; no changes were made: ${path}`);
    throw error;
  }
}

async function atomicWrite(path: string, value: JsonObject, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pinboard-${process.pid}-${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function backup(path: string, paths: PinboardPaths): Promise<string | null> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return null;
  }
  await mkdir(paths.backups, { recursive: true, mode: 0o700 });
  const destination = join(paths.backups, `claude-settings-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await copyFile(path, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  return destination;
}

export async function readClaudeHookStatus(home = homedir()): Promise<{ configured: boolean; path: string; error?: string }> {
  const path = claudeSettingsPath(home);
  try {
    const { value } = await readSettings(path);
    return { configured: claudeHooksConfigured(value), path };
  } catch (error) {
    return { configured: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function installClaudeHooks(options: { paths: PinboardPaths; home?: string }): Promise<{ changed: boolean; path: string; backup: string | null }> {
  const path = claudeSettingsPath(options.home);
  const current = await readSettings(path);
  const invocation = providerHookInvocation();
  const result = installClaudeHooksInSettings(current.value, invocation);
  if (!result.changed) return { changed: false, path, backup: null };
  const backupPath = await backup(path, options.paths);
  await atomicWrite(path, result.settings, current.mode);
  return { changed: true, path, backup: backupPath };
}

export async function removeClaudeHooks(options: { paths: PinboardPaths; home?: string }): Promise<{ changed: boolean; path: string; backup: string | null }> {
  const path = claudeSettingsPath(options.home);
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { changed: false, path, backup: null };
    throw error;
  }
  const current = await readSettings(path);
  const result = removeClaudeHooksFromSettings(current.value, providerHookInvocation());
  if (!result.changed) return { changed: false, path, backup: null };
  const backupPath = await backup(path, options.paths);
  await atomicWrite(path, result.settings, current.mode);
  return { changed: true, path, backup: backupPath };
}
