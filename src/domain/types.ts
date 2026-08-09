export type Provider = "claude-code" | "codex" | "cli" | "unknown";

export interface RepositoryContext {
  identity: string;
  name: string;
  root: string;
  branch: string;
}

export interface SessionInput {
  id: string;
  provider: Provider;
  providerSessionId?: string;
  repository: RepositoryContext;
  taskLabel?: string;
  pid?: number;
}

export interface SessionRecord {
  id: string;
  address: string;
  provider: Provider;
  providerSessionId: string | null;
  repositoryIdentity: string;
  repositoryName: string;
  repositoryRoot: string;
  branch: string;
  taskLabel: string | null;
  pid: number | null;
  state: "active" | "idle" | "ended" | "stale";
  startedAt: string;
  lastActiveAt: string;
  endedAt: string | null;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  senderSessionId: string | null;
  senderAddress: string;
  recipientSessionId: string;
  recipientAddress: string;
  body: string;
  status: "queued" | "surfaced" | "read";
  createdAt: string;
  surfacedAt: string | null;
  readAt: string | null;
}

export interface ThreadRecord {
  id: string;
  participants: string[];
  messageCount: number;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface LeaseRecord {
  id: string;
  ownerSessionId: string;
  ownerAddress: string;
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  note: string | null;
  createdAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface DaemonStatus {
  version: string;
  uptimeSeconds: number;
  sessions: { active: number; idle: number; stale: number };
  unreadMessages: number;
  activeLeases: number;
  databasePath: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface LocalExportSnapshot {
  format: "pinboard-local-export";
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  localIdentity: string;
  repositories: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  threads: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  messageReceipts: Record<string, unknown>[];
  leases: Record<string, unknown>[];
  settings: Record<string, unknown>[];
}
