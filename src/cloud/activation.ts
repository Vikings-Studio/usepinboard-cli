import { setCloudConfig, type CloudConfig } from "../config/settings.js";
import type { PinboardPaths } from "../platform/paths.js";

// Persist a Cloud connection and notify the local daemon, rolling the
// config back to `previousCloud` if either step fails. Callers own any
// additional side effects (credential files, auth device ids) and their
// rollback, so the helper stays focused on the cloud config contract.
export async function applyCloudConnection(options: {
  paths: PinboardPaths;
  nextCloud: CloudConfig;
  previousCloud: CloudConfig;
  notify?: (cloud: CloudConfig) => Promise<void>;
}): Promise<void> {
  let configured = false;
  try {
    await setCloudConfig(options.paths, options.nextCloud);
    configured = true;
    if (options.notify) await options.notify(options.nextCloud);
  } catch (error) {
    if (configured) await setCloudConfig(options.paths, options.previousCloud).catch(() => undefined);
    throw error;
  }
}
