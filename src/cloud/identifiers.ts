import { createHash } from "node:crypto";

export const CLOUD_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const CLOUD_RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isCloudIdentifier(value: unknown): value is string {
  return typeof value === "string" && CLOUD_IDENTIFIER_PATTERN.test(value);
}

export function deriveRepositoryId(repositoryIdentity: string): string {
  return `repo-${createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 32)}`;
}

export function requireCloudIdentifier(value: unknown, label: string): string {
  if (!isCloudIdentifier(value)) throw new Error(`${label} must be a stable 1-128 character identifier`);
  return value;
}

export function isCloudResourceId(value: unknown): value is string {
  return typeof value === "string" && CLOUD_RESOURCE_ID_PATTERN.test(value);
}

export function requireCloudResourceId(value: unknown, label: string): string {
  if (!isCloudResourceId(value)) throw new Error(`${label} must be a UUID`);
  return value;
}
