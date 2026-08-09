import { describe, expect, it } from "vitest";
import { readConfig, setConfig } from "../src/config/settings.js";
import { temporaryPaths } from "./helpers.js";

describe("local configuration", () => {
  it("uses versioned defaults and persists validated settings", async () => {
    const paths = await temporaryPaths();
    expect(await readConfig(paths)).toMatchObject({ version: 1, idleMinutes: 5, staleMinutes: 30 });
    await setConfig(paths, "idleMinutes", "10");
    expect(await readConfig(paths)).toMatchObject({ idleMinutes: 10, staleMinutes: 30 });
  });

  it("rejects invalid presence windows", async () => {
    const paths = await temporaryPaths();
    await expect(setConfig(paths, "staleMinutes", "2")).rejects.toThrow(/greater than idleMinutes/u);
  });
});
