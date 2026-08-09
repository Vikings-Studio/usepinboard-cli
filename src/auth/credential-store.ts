import { spawn } from "node:child_process";
import { platform } from "node:os";

// Pluggable OS credential-store abstraction for the device-auth access
// token. The token is a durable, revocable credential and must never be
// persisted in plaintext config. Each platform adapter shells out to the
// native credential manager so the secret is protected by the OS.
//
// The interface is deliberately small so tests can inject an in-memory
// fake and so a future native binding (e.g. keytar) can replace the
// adapters without touching callers.

export interface CredentialStore {
  save(service: string, account: string, secret: string): Promise<void>;
  read(service: string, account: string): Promise<string | null>;
  delete(service: string, account: string): Promise<void>;
}

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

// Hard ceiling on a single native CLI invocation so a hung keychain
// daemon or locked Secret Service cannot block the CLI indefinitely.
const COMMAND_TIMEOUT_MS = 15_000;

function run(command: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new CredentialStoreError(`The credential store command '${command}' timed out after ${String(COMMAND_TIMEOUT_MS)}ms`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// macOS Keychain via the `security` CLI. The secret is written through
// stdin so it never appears in the process list.
const macosStore: CredentialStore = {
  async save(service, account, secret) {
    const result = await run("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w"], secret);
    if (result.code !== 0) throw new CredentialStoreError(`macOS Keychain could not store the credential (${result.stderr.trim() || `exit ${String(result.code)}`})`);
  },
  async read(service, account) {
    const result = await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    if (result.code === 44) return null; // errSecItemNotFound
    if (result.code !== 0) throw new CredentialStoreError(`macOS Keychain could not read the credential (${result.stderr.trim() || `exit ${String(result.code)}`})`);
    return result.stdout.replace(/\n$/u, "");
  },
  async delete(service, account) {
    const result = await run("security", ["delete-generic-password", "-s", service, "-a", account]);
    if (result.code === 44) return; // already absent
    if (result.code !== 0) throw new CredentialStoreError(`macOS Keychain could not delete the credential (${result.stderr.trim() || `exit ${String(result.code)}`})`);
  },
};

// Linux Secret Service via `secret-tool` (libsecret). The secret is
// written through stdin.
const linuxStore: CredentialStore = {
  async save(service, account, secret) {
    const result = await run("secret-tool", ["store", "--label", service, "service", service, "account", account], secret);
    if (result.code !== 0) throw new CredentialStoreError(`The Secret Service could not store the credential (${result.stderr.trim() || `exit ${String(result.code)}`})`);
  },
  async read(service, account) {
    const result = await run("secret-tool", ["lookup", "service", service, "account", account]);
    if (result.code !== 0) throw new CredentialStoreError(`The Secret Service could not read the credential (${result.stderr.trim() || `exit ${String(result.code)}`})`);
    return result.stdout.length > 0 ? result.stdout.replace(/\n$/u, "") : null;
  },
  async delete(service, account) {
    const result = await run("secret-tool", ["clear", "service", service, "account", account]);
    // secret-tool exits 1 when no matching item exists; treat that as
    // idempotent success so `auth logout` is safe to run repeatedly and
    // after the credential was already removed.
    if (result.code === 1) return;
    if (result.code !== 0) throw new CredentialStoreError(`The Secret Service could not delete the credential (${result.stderr.trim() || `exit ${String(result.code)}`})`);
  },
};

// Windows Credential Manager is not reachable through a stable, safe
// command-line adapter that accepts arbitrary secrets without a native
// dependency. Fail closed with an actionable error rather than falling
// back to plaintext persistence.
const windowsStore: CredentialStore = {
  save() {
    return Promise.reject(new CredentialStoreError("Windows Credential Manager is not yet supported by the device-auth credential store. Install a native credential-store binding or use a supported platform."));
  },
  read() {
    return Promise.reject(new CredentialStoreError("Windows Credential Manager is not yet supported by the device-auth credential store."));
  },
  delete() {
    return Promise.reject(new CredentialStoreError("Windows Credential Manager is not yet supported by the device-auth credential store."));
  },
};

export function createCredentialStore(platformName: string = platform()): CredentialStore {
  switch (platformName) {
    case "darwin":
      return macosStore;
    case "linux":
      return linuxStore;
    case "win32":
      return windowsStore;
    default:
      throw new CredentialStoreError(`No OS credential store is available on ${platformName}. Refusing to persist the access token in plaintext.`);
  }
}
