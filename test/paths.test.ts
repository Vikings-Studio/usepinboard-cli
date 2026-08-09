import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { validatePurgeTarget } from "../src/platform/paths.js";

describe("purge target validation", () => {
  it("accepts a scoped application data directory", () => {
    expect(validatePurgeTarget("/Users/example/Library/Application Support/Pinboard", {
      cwd: "/workspace/project",
      home: "/Users/example",
    })).toBe(resolve("/Users/example/Library/Application Support/Pinboard"));
  });

  it.each(["/", "/Users/example", "/workspace/project"])("rejects broad target %s", (target) => {
    expect(() => validatePurgeTarget(target, { cwd: "/workspace/project", home: "/Users/example" })).toThrow(
      /Refusing to purge unsafe/u,
    );
  });
});
