import { describe, expect, it } from "vitest";
import {
  deriveSessionCapability,
  generateSessionCapability,
  hashSessionCapability,
  verifySessionCapability,
} from "../src/security/session-capability.js";

describe("session capabilities", () => {
  it("derives stable, session-bound provider capabilities", () => {
    expect(deriveSessionCapability("local-secret", "session-a")).toBe(deriveSessionCapability("local-secret", "session-a"));
    expect(deriveSessionCapability("local-secret", "session-a")).not.toBe(deriveSessionCapability("local-secret", "session-b"));
    expect(deriveSessionCapability("local-secret", "session-a")).not.toContain("local-secret");
  });

  it("generates a 256-bit capability and verifies only its hash", () => {
    const capability = generateSessionCapability();
    expect(Buffer.from(capability, "base64url")).toHaveLength(32);
    const hash = hashSessionCapability(capability);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifySessionCapability(capability, hash)).toBe(true);
    expect(verifySessionCapability(generateSessionCapability(), hash)).toBe(false);
  });
});
