import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { installUserService, removeUserService, restoreUserServiceManagerState, serviceDefinition, userServiceStatus, type CommandRunner } from "../src/platform/service.js";

const ok: CommandRunner = () => ({ status: 0, stdout: "", stderr: "" });

describe("platform user services", () => {
  it("renders escaped, secret-free launchd and systemd definitions", () => {
    const mac = serviceDefinition({ platform: "darwin", home: "/Users/a&b", nodeExecutable: "/opt/Node & Co/node", cliExecutable: "/opt/pin<board/cli.js", logPath: "/tmp/pin&board.log" });
    expect(mac.content).toContain("/opt/Node &amp; Co/node");
    expect(mac.content).toContain("Managed by @usepinboard/cli");
    expect(mac.content).not.toContain("PINBOARD_SESSION_CAPABILITY");

    const linux = serviceDefinition({ platform: "linux", home: "/home/test", nodeExecutable: "/opt/node 100%/node", cliExecutable: "/opt/pinboard/cli.js", logPath: "/tmp/pin board.log", pinboardHome: "/srv/pin board" });
    expect(linux.content).toContain('"/opt/node 100%%/node"');
    expect(linux.content).toContain("UMask=0077");
    expect(linux.content).toContain("NoNewPrivileges=true");
    expect(linux.content).toContain('Environment="PINBOARD_HOME=/srv/pin board"');
  });

  it("installs idempotently and removes only its owned Linux unit", async () => {
    const home = join("/tmp", `pinboard-service-${process.pid}-${Date.now()}`);
    const definition = serviceDefinition({ platform: "linux", home, nodeExecutable: "/opt/node", cliExecutable: "/opt/pinboard/cli.js", logPath: join(home, "pinboard.log") });
    if (!definition.path) throw new Error("Expected a Linux service path");
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    };
    expect((await installUserService(definition, runner)).changed).toBe(true);
    expect((await installUserService(definition, runner)).changed).toBe(false);
    expect(await readFile(definition.path, "utf8")).toBe(definition.content);
    expect(calls).toContain("systemctl --user enable --now pinboard.service");
    expect(await removeUserService(definition, runner)).toBe(true);
  });

  it("refuses unknown and symlinked service definitions", async () => {
    const home = join("/tmp", `pinboard-unsafe-service-${process.pid}-${Date.now()}`);
    const definition = serviceDefinition({ platform: "linux", home, nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    if (!definition.path) throw new Error("Expected a Linux service path");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(definition.path, "[Unit]\nDescription=user-owned\n", "utf8");
    await expect(installUserService(definition, ok)).rejects.toThrow(/not owned/u);

    await writeFile(definition.path, "# copied text: Managed by @usepinboard/cli\n[Unit]\nDescription=user-owned\n", "utf8");
    await expect(installUserService(definition, ok)).rejects.toThrow(/not owned/u);

    const linked = serviceDefinition({ platform: "linux", home: `${home}-link`, nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    if (!linked.path) throw new Error("Expected a Linux service path");
    await mkdir(join(`${home}-link`, ".config", "systemd", "user"), { recursive: true });
    const target = join(`${home}-link`, "target.service");
    await writeFile(target, "# Managed by @usepinboard/cli\n", "utf8");
    await symlink(target, linked.path);
    await expect(installUserService(linked, ok)).rejects.toThrow(/unsafe/u);
  });

  it("labels Windows as an explicit beta fallback", async () => {
    const definition = serviceDefinition({ platform: "win32", home: "C:\\Users\\test", nodeExecutable: "C:\\node.exe", cliExecutable: "C:\\cli.js" });
    expect(definition.supported).toBe(false);
    await expect(installUserService(definition, ok)).rejects.toThrow(/Windows remains best-effort beta/u);
  });

  it("rolls back a new definition when the service manager cannot start it", async () => {
    const home = join("/tmp", `pinboard-service-rollback-${process.pid}-${Date.now()}`);
    const definition = serviceDefinition({ platform: "linux", home, nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    if (!definition.path) throw new Error("Expected a Linux service path");
    const runner: CommandRunner = (_command, args) => ({
      status: args.includes("enable") ? 1 : 0,
      stdout: "",
      stderr: args.includes("enable") ? "user bus unavailable" : "",
    });
    await expect(installUserService(definition, runner)).rejects.toThrow(/user bus unavailable/u);
    await expect(readFile(definition.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports incomplete rollback instead of hiding manager failures", async () => {
    const home = join("/tmp", `pinboard-service-broken-rollback-${process.pid}-${Date.now()}`);
    const definition = serviceDefinition({ platform: "linux", home, nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    const runner: CommandRunner = (_command, args) => {
      if (args.includes("enable") && args.includes("--now")) return { status: 1, stdout: "", stderr: "start failed" };
      if (args.includes("daemon-reload")) return { status: 1, stdout: "", stderr: "reload failed" };
      return { status: 0, stdout: "", stderr: "" };
    };
    await expect(installUserService(definition, runner)).rejects.toThrow(/Rollback was incomplete[\s\S]*reload failed/u);
  });

  it("restores manager state after a partial failure with unchanged unit content", async () => {
    const home = join("/tmp", `pinboard-service-unchanged-rollback-${process.pid}-${Date.now()}`);
    const definition = serviceDefinition({ platform: "linux", home, nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    if (!definition.path || !definition.content) throw new Error("Expected a Linux service definition");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(definition.path, definition.content, "utf8");
    let enabled = false;
    const calls: string[] = [];
    const runner: CommandRunner = (_command, args) => {
      calls.push(args.join(" "));
      if (args.includes("is-enabled")) return { status: enabled ? 0 : 1, stdout: "", stderr: "" };
      if (args.includes("is-active")) return { status: 1, stdout: "", stderr: "" };
      if (args.includes("enable") && args.includes("--now")) {
        enabled = true;
        return { status: 1, stdout: "", stderr: "start failed" };
      }
      if (args.includes("disable")) enabled = false;
      return { status: 0, stdout: "", stderr: "" };
    };
    await expect(installUserService(definition, runner)).rejects.toThrow(/start failed/u);
    expect(enabled).toBe(false);
    expect(calls).toContain("--user disable pinboard.service");
  });

  it("does not report a loaded but stopped launchd job as running", async () => {
    const home = join("/tmp", `pinboard-launchd-status-${process.pid}-${Date.now()}`);
    const definition = serviceDefinition({ platform: "darwin", home, nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    if (!definition.path || !definition.content) throw new Error("Expected a launchd definition");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(definition.path, definition.content, "utf8");
    const stopped: CommandRunner = () => ({ status: 0, stdout: "state = not running\n", stderr: "" });
    const running: CommandRunner = () => ({ status: 0, stdout: "state = running\n", stderr: "" });
    expect(userServiceStatus(definition, stopped).running).toBe(false);
    if (platform() !== "win32") expect(userServiceStatus(definition, running).running).toBe(true);
  });

  it("restores previously positive systemd manager state in both directions", () => {
    const definition = serviceDefinition({ platform: "linux", home: "/tmp/pinboard-positive-state", nodeExecutable: "/opt/node", cliExecutable: "/opt/cli.js" });
    let enabled = false;
    let running = false;
    const runner: CommandRunner = (_command, args) => {
      if (args.includes("is-enabled")) return { status: enabled ? 0 : 1, stdout: "", stderr: "" };
      if (args.includes("is-active")) return { status: running ? 0 : 1, stdout: "", stderr: "" };
      if (args.includes("enable")) enabled = true;
      if (args.includes("start")) running = true;
      return { status: 0, stdout: "", stderr: "" };
    };
    restoreUserServiceManagerState(definition, { loaded: false, enabled: true, running: true }, runner);
    expect(enabled).toBe(true);
    expect(running).toBe(true);
  });
});
