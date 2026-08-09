import { spawn } from "node:child_process";
import { platform } from "node:os";

// Safe cross-platform browser opener. Uses the platform's default
// browser without shell interpolation so a verification URL can never
// inject shell commands. Returns false when no opener is available so
// the CLI can print the URL for the human to open manually.

export async function openBrowser(url: string): Promise<boolean> {
  const command = platform() === "darwin"
    ? { command: "open", args: [url] }
    : platform() === "win32"
      ? { command: "cmd", args: ["/c", "start", "", url] }
      : { command: "xdg-open", args: [url] };
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
