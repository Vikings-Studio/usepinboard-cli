import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/constants.js";
import { checkProtocolCompatibility, parseProtocolVersion } from "../src/protocol/version.js";

describe("protocol versioning", () => {
  it("parses positive integer versions", () => {
    expect(parseProtocolVersion(String(PROTOCOL_VERSION))).toBe(PROTOCOL_VERSION);
    expect(parseProtocolVersion([String(PROTOCOL_VERSION)])).toBe(PROTOCOL_VERSION);
  });

  it("rejects missing and malformed versions", () => {
    expect(parseProtocolVersion(undefined)).toBeNull();
    expect(parseProtocolVersion("1.0")).toBeNull();
    expect(parseProtocolVersion("-1")).toBeNull();
    expect(parseProtocolVersion("0")).toBeNull();
  });

  it("requires the current major", () => {
    expect(checkProtocolCompatibility(String(PROTOCOL_VERSION)).compatible).toBe(true);
    expect(checkProtocolCompatibility(String(PROTOCOL_VERSION + 1))).toEqual({
      compatible: false,
      expected: PROTOCOL_VERSION,
      received: PROTOCOL_VERSION + 1,
    });
  });
});
