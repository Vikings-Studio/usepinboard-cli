import type { PinboardConfig } from "../config/settings.js";
import type { SessionRecord } from "../domain/types.js";
import { sanitizeUntrustedText, truncateUtf8 } from "../security/untrusted.js";
import { CloudClientError, RelayClient, type RelayDiscoveryQuery, type RelayDiscoveryResult, type RelayDiscoverySession } from "./client.js";

export type CloudDiscoveryStatus = "disabled" | "unlinked" | "connected" | "degraded";

export interface DiscoveryEntry {
  origin: "local" | "cloud";
  id: string;
  address: string;
  provider: string;
  repositoryName: string;
  repositoryIdentity: string;
  repositoryRoot: string;
  branch: string;
  state: "active" | "idle" | "ended" | "stale";
  taskLabel: string | null;
  providerSessionId: string | null;
  pid: number | null;
  lastActiveAt: string;
  userId?: string;
  deviceId?: string;
}

export interface DiscoveryCloud {
  status: CloudDiscoveryStatus;
  reasonCode: string | null;
  matched: number | null;
  warning: string | null;
}

export interface DiscoveryResult {
  sessions: DiscoveryEntry[];
  cloud: DiscoveryCloud;
}

export interface DiscoveryRelay {
  discovery(query: RelayDiscoveryQuery): Promise<RelayDiscoveryResult>;
}

export interface CloudAwareWhoInput {
  config: PinboardConfig;
  repositoryIdentity: string;
  branch?: string;
  includeIdle: boolean;
  repositoryId: string | null;
  token: string | null;
  client?: DiscoveryRelay | null;
  listLocal: () => Promise<SessionRecord[]>;
  excludeSessionId?: string;
}

function localEntry(session: SessionRecord): DiscoveryEntry {
  return {
    origin: "local",
    id: session.id,
    address: session.address,
    provider: session.provider,
    repositoryName: session.repositoryName,
    repositoryIdentity: session.repositoryIdentity,
    repositoryRoot: session.repositoryRoot,
    branch: session.branch,
    state: session.state,
    taskLabel: session.taskLabel,
    providerSessionId: session.providerSessionId,
    pid: session.pid,
    lastActiveAt: session.lastActiveAt,
  };
}

function cloudEntry(session: RelayDiscoverySession): DiscoveryEntry {
  return {
    origin: "cloud",
    id: session.id,
    // Team sends are user-targeted. Keep this field directly copyable into
    // `pinboard send`; the session/device/provider details remain available
    // in their dedicated machine-readable fields below.
    address: `team/${session.userId}`,
    provider: session.provider,
    repositoryName: session.repositoryId,
    repositoryIdentity: session.repositoryId,
    repositoryRoot: session.repositoryId,
    branch: session.branch,
    state: session.state,
    taskLabel: session.taskLabel,
    providerSessionId: session.providerSessionId,
    pid: null,
    lastActiveAt: session.lastActiveAt,
    userId: session.userId,
    deviceId: session.deviceId,
  };
}

function sortEntries(entries: DiscoveryEntry[]): DiscoveryEntry[] {
  const byKey = new Map<string, DiscoveryEntry>();
  for (const entry of entries) byKey.set(`${entry.origin}:${entry.id}`, entry);
  return [...byKey.values()].sort((a, b) => {
    const delta = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
    if (delta !== 0) return delta;
    const origin = a.origin.localeCompare(b.origin);
    if (origin !== 0) return origin;
    return a.id.localeCompare(b.id);
  });
}

export async function cloudAwareWho(input: CloudAwareWhoInput): Promise<DiscoveryResult> {
  const local = (await input.listLocal())
    .filter((session) => session.id !== input.excludeSessionId)
    .map(localEntry);

  const cloud = input.config.cloud;
  const enabled = cloud.enabled && Boolean(cloud.apiUrl) && Boolean(cloud.organizationId) && Boolean(input.token);
  if (!enabled) {
    return { sessions: sortEntries(local), cloud: { status: "disabled", reasonCode: null, matched: null, warning: null } };
  }
  if (!input.repositoryId) {
    return { sessions: sortEntries(local), cloud: { status: "unlinked", reasonCode: null, matched: null, warning: null } };
  }

  let status: CloudDiscoveryStatus = "connected";
  let reasonCode: string | null = null;
  let matched: number | null = null;
  let warning: string | null = null;
  let cloudEntries: DiscoveryEntry[] = [];
  try {
    const relay = input.client ?? new RelayClient(cloud.apiUrl as string, input.token as string);
    const result = await relay.discovery({
      repositoryId: input.repositoryId,
      includeIdle: input.includeIdle,
      ...(input.branch ? { branch: input.branch } : {}),
    });
    cloudEntries = result.sessions.map(cloudEntry);
    reasonCode = result.meta.reasonCode;
    matched = result.meta.matched;
  } catch (error) {
    status = "degraded";
    const code = error instanceof CloudClientError ? error.code : "RELAY_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    reasonCode = code;
    warning = `Cloud discovery unavailable (${code}): ${truncateUtf8(sanitizeUntrustedText(message), 512)}`;
  }

  return {
    sessions: sortEntries([...local, ...cloudEntries]),
    cloud: { status, reasonCode, matched, warning },
  };
}
