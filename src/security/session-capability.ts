import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_CAPABILITY_HEADER = "x-pinboard-session-capability";

export function generateSessionCapability(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveSessionCapability(localSecret: string, sessionId: string): string {
  return createHmac("sha256", localSecret)
    .update("pinboard-session-capability-v1\0", "utf8")
    .update(sessionId, "utf8")
    .digest("base64url");
}

export function hashSessionCapability(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

export function verifySessionCapability(capability: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSessionCapability(capability), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
