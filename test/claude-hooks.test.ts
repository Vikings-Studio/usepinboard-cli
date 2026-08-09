import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import {
  claudeHooksConfigured,
  claudeSettingsPath,
  installClaudeHooks,
  installClaudeHooksInSettings,
  removeClaudeHooks,
  removeClaudeHooksFromSettings,
} from "../src/integrations/claude-hooks.js";
import { temporaryPaths } from "./helpers.js";

describe("Claude Code hook configuration", () => {
  it("adds supported events without discarding unknown settings", () => {
    const original = { permissions: { allow: ["Read"] }, hooks: { Notification: [{ hooks: [{ type: "command", command: "notify" }] }] } };
    const result = installClaudeHooksInSettings(original);
    expect(result.changed).toBe(true);
    expect(result.settings.permissions).toEqual(original.permissions);
    expect(claudeHooksConfigured(result.settings, { command: "pinboard hook claude-code" })).toBe(true);
    expect(original).not.toHaveProperty("hooks.SessionStart");
  });

  it("is idempotent and removes only Pinboard-owned handlers", () => {
    const installed = installClaudeHooksInSettings({
      hooks: { SessionStart: [{ matcher: "custom", hooks: [{ type: "command", command: "user-hook" }] }] },
    }).settings;
    expect(installClaudeHooksInSettings(installed).changed).toBe(false);
    const removed = removeClaudeHooksFromSettings(installed);
    expect(removed.changed).toBe(true);
    expect(removed.settings).toMatchObject({
      hooks: { SessionStart: [{ matcher: "custom", hooks: [{ type: "command", command: "user-hook" }] }] },
    });
  });

  it("uses an exec-form packaged command and upgrades legacy shell handlers", () => {
    const invocation = { command: "/opt/node", args: ["/opt/@usepinboard/cli/dist/cli.js", "hook", "claude-code"] };
    const installed = installClaudeHooksInSettings({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "pinboard hook claude-code", timeout: 5 }] }] },
    }, invocation);
    expect(claudeHooksConfigured(installed.settings, invocation)).toBe(true);
    expect(JSON.stringify(installed.settings)).not.toContain('"command":"pinboard hook claude-code"');
    expect(JSON.stringify(installed.settings)).toContain('"command":"/opt/node"');
  });

  it("backs up, preserves mode, and safely removes", async () => {
    const paths = await temporaryPaths();
    const home = join(paths.dataDir, "profile");
    const settings = claudeSettingsPath(home);
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settings, '{"theme":"dark"}\n', { mode: 0o640 });
    await chmod(settings, 0o640);

    const installed = await installClaudeHooks({ paths, home });
    expect(installed.changed).toBe(true);
    expect(installed.backup).not.toBeNull();
    if (!installed.backup) throw new Error("Expected a settings backup");
    expect(JSON.parse(await readFile(settings, "utf8"))).toMatchObject({ theme: "dark" });
    if (platform() !== "win32") {
      expect((await lstat(settings)).mode & 0o777).toBe(0o640);
      expect((await lstat(installed.backup)).mode & 0o777).toBe(0o600);
    }
    expect((await installClaudeHooks({ paths, home })).changed).toBe(false);

    const removed = await removeClaudeHooks({ paths, home });
    expect(removed.changed).toBe(true);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ theme: "dark" });
  });

  it("refuses malformed and symlinked settings", async () => {
    const paths = await temporaryPaths();
    const malformedHome = join(paths.dataDir, "malformed");
    await mkdir(join(malformedHome, ".claude"), { recursive: true });
    await writeFile(claudeSettingsPath(malformedHome), "{not-json", "utf8");
    await expect(installClaudeHooks({ paths, home: malformedHome })).rejects.toThrow(/not valid JSON/u);

    const linkedHome = join(paths.dataDir, "linked");
    const target = join(paths.dataDir, "actual-settings.json");
    await mkdir(join(linkedHome, ".claude"), { recursive: true });
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, claudeSettingsPath(linkedHome));
    await expect(installClaudeHooks({ paths, home: linkedHome })).rejects.toThrow(/symlinked/u);
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });
});
