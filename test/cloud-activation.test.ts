import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { applyCloudConnection } from "../src/cloud/activation.js";
import { readConfig, setCloudConfig, type CloudConfig } from "../src/config/settings.js";
import { temporaryPaths } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const previousCloud: CloudConfig = {
  enabled: true,
  apiUrl: "https://relay.example.test",
  organizationId: "org_before",
  userId: "user_before",
  deviceId: "device_before",
  syncPaused: false,
};

const nextCloud: CloudConfig = {
  enabled: true,
  apiUrl: "https://relay.example.test",
  organizationId: "org_after",
  userId: "user_after",
  deviceId: "device_after",
  syncPaused: false,
};

describe("cloud connection activation", () => {
  it("persists the next config and notifies the daemon on success", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    await setCloudConfig(paths, previousCloud);
    const notified: CloudConfig[] = [];
    await applyCloudConnection({
      paths,
      nextCloud,
      previousCloud,
      notify: (cloud) => { notified.push(cloud); return Promise.resolve(); },
    });
    expect(await readConfig(paths)).toMatchObject({ cloud: nextCloud });
    expect(notified).toEqual([nextCloud]);
  });

  it("rolls the config back to the previous value when daemon notification fails", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    await setCloudConfig(paths, previousCloud);
    await expect(applyCloudConnection({
      paths,
      nextCloud,
      previousCloud,
      notify: () => Promise.reject(new Error("daemon offline")),
    })).rejects.toThrow("daemon offline");
    expect(await readConfig(paths)).toMatchObject({ cloud: previousCloud });
  });

  it("keeps the previous config when persisting the next config itself fails", async () => {
    const paths = await temporaryPaths();
    cleanup.push(paths.dataDir);
    await setCloudConfig(paths, previousCloud);
    const invalid = { ...nextCloud, organizationId: "has/slash" };
    await expect(applyCloudConnection({
      paths,
      nextCloud: invalid,
      previousCloud,
    })).rejects.toThrow();
    expect(await readConfig(paths)).toMatchObject({ cloud: previousCloud });
  });
});
