import { describe, expect, it } from "vitest";
import { runtimeSupported } from "../src/platform/runtime.js";

describe("runtime support", () => {
  it.each([
    ["23.11.0", false],
    ["24.0.0", false],
    ["24.14.9", false],
    ["24.15.0", true],
    ["25.0.0", true],
    ["26.0.0", true],
  ])("classifies Node %s", (version, expected) => {
    expect(runtimeSupported(version)).toBe(expected);
  });
});
