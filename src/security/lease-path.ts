import { posix } from "node:path";

const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/u;

function hasControlOrBidi(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f) || BIDI_CONTROL.test(value[index] ?? "")) {
      return true;
    }
  }
  return false;
}

/**
 * Validate and normalize a repository-relative path or glob without touching
 * the filesystem. Globs remain declarative; traversal and platform-specific
 * absolute paths are rejected before they reach storage or a matcher.
 */
export function normalizeLeasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Lease paths cannot be empty");
  if (hasControlOrBidi(trimmed)) throw new Error("Lease paths cannot contain control or bidi characters");
  if (trimmed.includes("\\")) throw new Error("Lease paths must use forward slashes");
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE.test(trimmed)) {
    throw new Error("Lease paths must be repository-relative");
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error("Lease paths cannot traverse outside the repository");
  if (segments.some((segment) => segment === "." || segment === "")) {
    throw new Error("Lease paths must not contain empty or current-directory segments");
  }

  const normalized = posix.normalize(trimmed);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Lease paths cannot traverse outside the repository");
  }
  return normalized;
}

export function normalizeLeasePaths(values: string[]): string[] {
  return [...new Set(values.map(normalizeLeasePath))];
}
