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
    expect(
      makeAddress(
        "claude-code",
        "billing api",
        "https://github.com/example/billing-api",
        "feature/auth",
      ),
    ).toMatch(
      /^local\/claude-code@billing-api~[a-f0-9]{32}#feature-auth$/u,
    );
  });

  it("distinguishes repositories that share a basename", () => {
    const first = makeAddress("codex", "api", "https://github.com/first/api", "main");
    const second = makeAddress("codex", "api", "https://github.com/second/api", "main");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^local\/codex@api~/u);
    expect(second).toMatch(/^local\/codex@api~/u);
  });
});
