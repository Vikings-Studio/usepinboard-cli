import { describe, expect, it } from "vitest";
import { resolveDiscoveryRepository } from "../src/mcp/server.js";

describe("MCP discovery scope", () => {
  it("defaults discovery to the current repository", () => {
    expect(resolveDiscoveryRepository(undefined, "https://github.com/example/current")).toBe(
      "https://github.com/example/current",
    );
  });

  it("preserves an explicit repository scope", () => {
    expect(
      resolveDiscoveryRepository(
        "https://github.com/example/requested",
        "https://github.com/example/current",
      ),
    ).toBe("https://github.com/example/requested");
  });
});
