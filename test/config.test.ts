import { describe, expect, it } from "vitest";
import { readConfig, setCloudConfig, setConfig } from "../src/config/settings.js";
import { writeFile } from "node:fs/promises";
import { temporaryPaths } from "./helpers.js";

describe("local configuration", () => {
  it("uses versioned defaults and persists validated settings", async () => {
    const paths = await temporaryPaths();
    expect(await readConfig(paths)).toMatchObject({ version: 2, idleMinutes: 5, staleMinutes: 30, cloud: { enabled: false } });
    await setConfig(paths, "idleMinutes", "10");
    expect(await readConfig(paths)).toMatchObject({ idleMinutes: 10, staleMinutes: 30 });
  });

  it("migrates v1 in memory and persists non-secret cloud settings", async () => {
    const paths = await temporaryPaths();
    await writeFile(paths.config, JSON.stringify({ version: 1, idleMinutes: 7, staleMinutes: 40 }));
    const migrated = await readConfig(paths);
    expect(migrated).toMatchObject({ version: 2, idleMinutes: 7, cloud: { enabled: false, apiUrl: null } });
    const updated = await setCloudConfig(paths, {
      enabled: true,
      apiUrl: "https://relay.example.test",
      organizationId: "org_test",
      userId: "user_test",
      deviceId: "device_test",
      syncPaused: false,
    });
    expect(JSON.stringify(updated)).not.toContain("token");
  });

  it("rejects invalid presence windows", async () => {
    const paths = await temporaryPaths();
    await expect(setConfig(paths, "staleMinutes", "2")).rejects.toThrow(/greater than idleMinutes/u);
  });
});
