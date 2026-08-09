import { describe, expect, it } from "vitest";
import { normalizeLeasePath, normalizeLeasePaths } from "../src/security/lease-path.js";

describe("lease path validation", () => {
  it("accepts repository-relative paths and globs", () => {
    expect(normalizeLeasePath("src/domain/*.ts")).toBe("src/domain/*.ts");
    expect(normalizeLeasePath("docs/**/README.md")).toBe("docs/**/README.md");
  });

  it.each(["../secret", "src/../secret", "/etc/passwd", "C:\\secret", "src\\file.ts", "src//file.ts", "./src"]) (
    "rejects unsafe path %s",
    (value) => expect(() => normalizeLeasePath(value)).toThrow(),
  );

  it("rejects invisible control and bidi characters", () => {
    expect(() => normalizeLeasePath("src/\u202efile.ts")).toThrow(/bidi/u);
    expect(() => normalizeLeasePath("src/\u0000file.ts")).toThrow(/control/u);
  });

  it("deduplicates normalized paths", () => {
    expect(normalizeLeasePaths(["src/*.ts", " src/*.ts "])).toEqual(["src/*.ts"]);
  });
});
