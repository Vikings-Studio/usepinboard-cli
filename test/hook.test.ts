import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES } from "../src/constants.js";
import { parseHookPayload } from "../src/integrations/hook.js";

describe("provider hook input", () => {
  it("accepts an object payload", () => {
    expect(parseHookPayload(Buffer.from('{"session_id":"session-1"}'))).toEqual({ session_id: "session-1" });
  });

  it("rejects non-object JSON", () => {
    expect(() => parseHookPayload(Buffer.from("[]"))).toThrow(/JSON object/u);
  });

  it("rejects oversized input before parsing", () => {
    expect(() => parseHookPayload(Buffer.alloc(MAX_REQUEST_BYTES + 1))).toThrow(/exceeds 64 KiB/u);
  });
});
