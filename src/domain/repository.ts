import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { RepositoryContext } from "./types.js";

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function normalizeGitRemote(remote: string): string {
  const value = remote.trim().replace(/\.git$/u, "");
  const scp = /^git@([^:]+):(.+)$/u.exec(value);
  if (scp?.[1] && scp[2]) return `https://${scp[1].toLowerCase()}/${scp[2]}`;

  try {
    const url = new URL(value);
    if (url.protocol === "ssh:") {
      return `https://${url.hostname.toLowerCase()}${url.pathname}`;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.protocol = "https:";
      url.username = "";
      url.password = "";
      url.hostname = url.hostname.toLowerCase();
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    }
  } catch {
    // Fall through to a stable opaque value.
  }
  return value;
}

export function detectRepository(cwd = process.cwd()): RepositoryContext {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root) {
    const absolute = resolve(cwd);
    return {
      identity: `local:${createHash("sha256").update(absolute).digest("hex").slice(0, 16)}`,
      name: basename(absolute),
      root: absolute,
      branch: "detached",
    };
  }

  const remote = git(["remote", "get-url", "origin"], root);
  const branch = git(["branch", "--show-current"], root) || "detached";
  return {
    identity: remote
      ? normalizeGitRemote(remote)
      : `local:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
    name: basename(root),
    root,
    branch,
  };
}

export function makeAddress(provider: string, repositoryName: string, branch: string): string {
  const safe = (value: string) => value.replace(/[\s/@#]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
  return `local/${safe(provider)}@${safe(repositoryName)}#${safe(branch)}`;
}
