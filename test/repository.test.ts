import { describe, expect, it } from "vitest";
import { makeAddress, normalizeGitRemote } from "../src/domain/repository.js";

describe("repository identity", () => {
  it.each([
    ["git@github.com:Vikings-Studio/usepinboard-cli.git", "https://github.com/Vikings-Studio/usepinboard-cli"],
    ["ssh://git@github.com/Vikings-Studio/usepinboard-cli.git", "https://github.com/Vikings-Studio/usepinboard-cli"],
    ["http://GitHub.com/Vikings-Studio/usepinboard-cli.git", "https://github.com/Vikings-Studio/usepinboard-cli"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeGitRemote(input)).toBe(expected);
  });

  it("creates a human-readable stable address", () => {
    expect(makeAddress("claude-code", "billing api", "feature/auth")).toBe(
      "local/claude-code@billing-api#feature-auth",
    );
  });
});
