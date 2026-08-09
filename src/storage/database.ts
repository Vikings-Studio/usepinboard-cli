import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  MAX_LEASE_NOTE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_TASK_LABEL_BYTES,
} from "../constants.js";
import { readConfig, type PinboardConfig } from "../config/settings.js";
import { makeAddress } from "../domain/repository.js";
import type {
  DaemonStatus,
  LeaseRecord,
  MessageRecord,
  LocalExportSnapshot,
  SessionInput,
  SessionRecord,
  ThreadRecord,
  CloudConnectionRecord,
  CloudRepositoryLink,
  CloudQueueRecord,
} from "../domain/types.js";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";
import { normalizeLeasePaths } from "../security/lease-path.js";
import { verifySessionCapability as capabilityMatches } from "../security/session-capability.js";
import { sanitizeUntrustedText, truncateUtf8 } from "../security/untrusted.js";
import { SCHEMA_MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import { CLOUD_IDENTIFIER_PATTERN, isCloudResourceId, requireCloudIdentifier, requireCloudResourceId } from "../cloud/identifiers.js";

type SqlRow = Record<string, unknown>;

function asRow(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a database row");
  return value as SqlRow;
}

function iso(value: unknown): string {
  return new Date(Number(value)).toISOString();
}

function optionalIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  throw new Error("Expected a scalar text database value");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function namespacedUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256").update(`${namespace}\0${value}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PinboardDatabase {
  readonly paths: PinboardPaths;
  readonly database: DatabaseSync;
  readonly config: PinboardConfig;

  private constructor(paths: PinboardPaths, database: DatabaseSync, config: PinboardConfig) {
    this.paths = paths;
    this.database = database;
    this.config = config;
  }

  static async open(paths: PinboardPaths = getPaths()): Promise<PinboardDatabase> {
    await ensureDirectories(paths);
    const database = new DatabaseSync(paths.database);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const versionRow = asRow(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get());
    const currentVersion = Number(versionRow.version);
    if (currentVersion > SCHEMA_VERSION) {
      database.close();
      throw new Error(`Database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    for (const migration of SCHEMA_MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        database.close();
        throw error;
      }
    }
    const config = await readConfig(paths);
    return new PinboardDatabase(paths, database, config);
  }

  close(): void {
    this.database.close();
  }

  localIdentity(): string {
    const existing = this.database.prepare("SELECT id FROM local_identity LIMIT 1").get();
    if (existing) return text(asRow(existing).id);
    const id = randomUUID();
    this.database.prepare("INSERT INTO local_identity(id, created_at) VALUES (?, ?)").run(id, Date.now());
    return id;
  }

  exportSnapshot(): LocalExportSnapshot {
    const rows = (table: string): Record<string, unknown>[] =>
      this.database.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...(row as Record<string, unknown>) }));
    return {
      format: "pinboard-local-export",
      formatVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      localIdentity: this.localIdentity(),
      repositories: rows("repositories"),
      sessions: this.database.prepare(
        `SELECT id, address, provider, provider_session_id, repository_identity, branch,
                task_label, pid, state, started_at, last_active_at, ended_at
         FROM sessions`,
      ).all().map((row) => ({ ...(row as Record<string, unknown>) })),
      threads: rows("threads"),
      messages: rows("messages"),
      messageReceipts: rows("message_receipts"),
      leases: rows("leases"),
      settings: rows("settings"),
    };
  }

  registerSession(input: SessionInput, capabilityHash?: string): SessionRecord {
    const now = Date.now();
    const taskLabel = input.taskLabel ? truncateUtf8(sanitizeUntrustedText(input.taskLabel), MAX_TASK_LABEL_BYTES) : null;
    const address = makeAddress(
      input.provider,
      input.repository.name,
      input.repository.identity,
      input.repository.branch,
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO repositories(identity, name, root, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(identity) DO UPDATE SET name = excluded.name, root = excluded.root, updated_at = excluded.updated_at`,
        )
        .run(input.repository.identity, input.repository.name, input.repository.root, now, now);
      this.database
        .prepare(
          `INSERT INTO sessions(
             id, address, provider, provider_session_id, repository_identity, branch,
             task_label, pid, state, started_at, last_active_at, ended_at
             , capability_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET
             address = excluded.address,
             provider = excluded.provider,
             provider_session_id = excluded.provider_session_id,
             repository_identity = excluded.repository_identity,
             branch = excluded.branch,
             task_label = COALESCE(excluded.task_label, sessions.task_label),
             pid = excluded.pid,
             state = 'active',
             capability_hash = COALESCE(excluded.capability_hash, sessions.capability_hash),
             last_active_at = excluded.last_active_at,
             ended_at = NULL`,
        )
        .run(
          input.id,
          address,
          input.provider,
          input.providerSessionId ?? null,
          input.repository.identity,
          input.repository.branch,
          taskLabel,
          input.pid ?? null,
          now,
          now,
          capabilityHash ?? null,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getSession(input.id);
  }

  sessionCapabilityMatches(sessionId: string, capability: string | undefined): boolean {
    if (!capability) return false;
    const row = this.database.prepare("SELECT capability_hash FROM sessions WHERE id = ?").get(sessionId);
    if (!row) return false;
    const expectedHash = nullableText(asRow(row).capability_hash);
    return expectedHash !== null && capabilityMatches(capability, expectedHash);
  }

  heartbeat(sessionId: string, taskLabel?: string): SessionRecord {
    const cleaned = taskLabel ? truncateUtf8(sanitizeUntrustedText(taskLabel), MAX_TASK_LABEL_BYTES) : null;
    const result = this.database
      .prepare(
        `UPDATE sessions
         SET state = 'active', last_active_at = ?, task_label = COALESCE(?, task_label), ended_at = NULL
         WHERE id = ?`,
      )
      .run(Date.now(), cleaned, sessionId);
    if (Number(result.changes) === 0) throw new Error(`Session ${sessionId} was not found`);
    return this.getSession(sessionId);
  }

  endSession(sessionId: string): void {
    const now = Date.now();
    this.database
      .prepare("UPDATE sessions SET state = 'ended', ended_at = ?, last_active_at = ? WHERE id = ?")
      .run(now, now, sessionId);
  }

  getSession(sessionId: string): SessionRecord {
    const row = this.database
      .prepare(
        `SELECT s.*, r.name AS repository_name, r.root AS repository_root
         FROM sessions s JOIN repositories r ON r.identity = s.repository_identity
         WHERE s.id = ?`,
      )
      .get(sessionId);
    if (!row) throw new Error(`Session ${sessionId} was not found`);
    return this.mapSession(asRow(row));
  }

  refreshPresenceStates(now = Date.now()): void {
    const idleCutoff = now - this.config.idleMinutes * 60_000;
    const staleCutoff = now - this.config.staleMinutes * 60_000;
    this.database
      .prepare("UPDATE sessions SET state = 'idle' WHERE state = 'active' AND last_active_at < ?")
      .run(idleCutoff);
    this.database
      .prepare("UPDATE sessions SET state = 'stale' WHERE state IN ('active', 'idle') AND last_active_at < ?")
      .run(staleCutoff);
  }

  listPresence(options: {
    repositoryIdentity?: string;
    branch?: string;
    includeIdle?: boolean;
    includeStale?: boolean;
  } = {}): SessionRecord[] {
    this.refreshPresenceStates();
    const conditions = ["s.state != 'ended'"];
    const values: Array<string | number> = [];
    if (!options.includeIdle) conditions.push("s.state = 'active'");
    else if (!options.includeStale) conditions.push("s.state IN ('active', 'idle')");
    if (options.repositoryIdentity) {
      conditions.push("s.repository_identity = ?");
      values.push(options.repositoryIdentity);
    }
    if (options.branch) {
      conditions.push("s.branch = ?");
      values.push(options.branch);
    }
    const statement = this.database.prepare(
      `SELECT s.*, r.name AS repository_name, r.root AS repository_root
       FROM sessions s JOIN repositories r ON r.identity = s.repository_identity
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.last_active_at DESC`,
    );
    return this.all(statement, values).map((row) => this.mapSession(row));
  }

  listSessionsForCloud(): SessionRecord[] {
    this.refreshPresenceStates();
    return this.all(
      this.database.prepare(
        `SELECT s.*, r.name AS repository_name, r.root AS repository_root
         FROM sessions s JOIN repositories r ON r.identity = s.repository_identity
         ORDER BY s.last_active_at DESC`,
      ),
      [],
    ).map((row) => this.mapSession(row));
  }

  sendMessage(input: {
    senderSessionId?: string;
    to: string;
    body: string;
    threadId?: string;
    idempotencyKey?: string;
  }): { message: MessageRecord; alternatives: SessionRecord[] } {
    if (!input.body.trim()) throw new Error("Message cannot be empty");
    if (byteLength(input.body) > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 32 KiB");
    if (input.idempotencyKey) {
      const existing = this.database.prepare("SELECT id FROM messages WHERE idempotency_key = ?").get(input.idempotencyKey);
      if (existing) return { message: this.getMessage(text(asRow(existing).id)), alternatives: [] };
    }
    this.refreshPresenceStates();
    const matches = this.all(
      this.database.prepare(
        `SELECT s.*, r.name AS repository_name, r.root AS repository_root
         FROM sessions s JOIN repositories r ON r.identity = s.repository_identity
         WHERE (s.address = ? OR s.id = ?) AND s.state IN ('active', 'idle')
         ORDER BY s.last_active_at DESC`,
      ),
      [input.to, input.to],
    ).map((row) => this.mapSession(row));
    const matchedRepositories = new Set(matches.map((session) => session.repositoryIdentity));
    if (matchedRepositories.size > 1) {
      throw new Error(`Address ${input.to} is ambiguous across repositories`);
    }
    const recipient = matches[0];
    if (!recipient) throw new Error(`No active session matches ${input.to}`);

    let senderAddress = "local/human@cli#manual";
    if (input.senderSessionId) senderAddress = this.getSession(input.senderSessionId).address;
    const now = Date.now();
    const threadId = input.threadId ?? randomUUID();
    const id = randomUUID();
    const body = sanitizeUntrustedText(input.body);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO threads(id, created_at, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(threadId, now, now);
      this.database
        .prepare(
          `INSERT INTO messages(
             id, thread_id, sender_session_id, sender_address, recipient_session_id,
             recipient_address, body, status, created_at, idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          id,
          threadId,
          input.senderSessionId ?? null,
          senderAddress,
          recipient.id,
          recipient.address,
          body,
          now,
          input.idempotencyKey ?? null,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { message: this.getMessage(id), alternatives: matches.slice(1) };
  }

  queueCloudMessage(input: {
    organizationId: string;
    senderSessionId: string;
    recipientUserId: string;
    body: string;
    threadId?: string;
    idempotencyKey: string;
  }): CloudQueueRecord {
    requireCloudIdentifier(input.organizationId, "Organization ID");
    requireCloudIdentifier(input.recipientUserId, "Recipient user ID");
    if (!input.body.trim()) throw new Error("Message cannot be empty");
    if (byteLength(input.body) > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 32 KiB");
    const sender = this.getSession(input.senderSessionId);
    const link = this.cloudRepositoryForIdentity(input.organizationId, sender.repositoryIdentity);
    if (!link) throw new Error("The sender repository is not linked to the active team");
    const localThreadId = input.threadId ?? randomUUID();
    const remoteThreadId = this.cloudRemoteThreadId(input.organizationId, link.repositoryId, localThreadId);
    return this.queueCloudOutbox({
      organizationId: input.organizationId,
      kind: "message",
      idempotencyKey: input.idempotencyKey,
      payload: {
        repositoryId: link.repositoryId,
        senderSessionId: sender.id,
        recipientUserId: input.recipientUserId,
        body: sanitizeUntrustedText(input.body),
        localThreadId,
        ...(remoteThreadId ? { threadId: remoteThreadId } : {}),
      },
    });
  }

  inbox(input: { sessionId: string; unreadOnly?: boolean; queuedOnly?: boolean; limit?: number }): MessageRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const conditions = [
      "recipient_session_id = ?",
      `NOT EXISTS (
        SELECT 1 FROM cloud_inbox ci
        WHERE ci.organization_id = messages.cloud_organization_id
          AND ci.remote_message_id = messages.cloud_message_id
          AND ci.state = 'superseded'
      )`,
    ];
    const values: Array<string | number> = [input.sessionId];
    if (input.unreadOnly) conditions.push("status != 'read'");
    if (input.queuedOnly) conditions.push("status = 'queued'");
    const rows = this.all(
      this.database.prepare(
        `SELECT * FROM messages WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT ?`,
      ),
      [...values, limit],
    );
    const surfacedAt = Date.now();
    const update = this.database.prepare(
      "UPDATE messages SET status = 'surfaced', surfaced_at = COALESCE(surfaced_at, ?) WHERE id = ? AND status = 'queued'",
    );
    for (const row of rows) {
      update.run(surfacedAt, text(row.id));
      const cloudOrganizationId = nullableText(row.cloud_organization_id);
      const cloudMessageId = nullableText(row.cloud_message_id);
      if (cloudOrganizationId && cloudMessageId) {
        this.queueCloudReceipt(cloudOrganizationId, cloudMessageId, input.sessionId, "surfaced");
        this.database.prepare("UPDATE cloud_inbox SET state = 'surfaced', surfaced_at = COALESCE(surfaced_at, ?) WHERE organization_id = ? AND remote_message_id = ?")
          .run(surfacedAt, cloudOrganizationId, cloudMessageId);
      }
    }
    return rows.map((row) => this.getMessage(text(row.id)));
  }

  listThreads(input: { sessionId?: string; limit?: number } = {}): ThreadRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const sessionFilter = input.sessionId
      ? "WHERE m.sender_session_id = ? OR m.recipient_session_id = ?"
      : "";
    const values: Array<string | number> = input.sessionId ? [input.sessionId, input.sessionId, limit] : [limit];
    const rows = this.all(
      this.database.prepare(
        `SELECT
           t.id,
           t.created_at,
           t.updated_at,
           MAX(m.created_at) AS last_message_at,
           COUNT(m.id) AS message_count,
           SUM(CASE WHEN m.status != 'read'${input.sessionId ? " AND m.recipient_session_id = ?" : ""} THEN 1 ELSE 0 END) AS unread_count,
           GROUP_CONCAT(DISTINCT m.sender_address) AS senders,
           GROUP_CONCAT(DISTINCT m.recipient_address) AS recipients
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
         ${sessionFilter}
         GROUP BY t.id
         ORDER BY last_message_at DESC
         LIMIT ?`,
      ),
      input.sessionId ? [input.sessionId, input.sessionId, input.sessionId, limit] : values,
    );
    return rows.map((row) => ({
      id: text(row.id),
      participants: [...new Set([...text(row.senders).split(","), ...text(row.recipients).split(",")])],
      messageCount: Number(row.message_count),
      unreadCount: Number(row.unread_count),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      lastMessageAt: iso(row.last_message_at),
    }));
  }

  markRead(messageId: string, sessionId: string): void {
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database
        .prepare(
          "UPDATE messages SET status = 'read', surfaced_at = COALESCE(surfaced_at, ?), read_at = ? WHERE id = ? AND recipient_session_id = ?",
        )
        .run(now, now, messageId, sessionId);
      if (Number(updated.changes) === 0) {
        throw new Error(`Message ${messageId} was not found for session ${sessionId}`);
      }
      this.database
        .prepare(
          "INSERT OR IGNORE INTO message_receipts(id, message_id, session_id, type, created_at) VALUES (?, ?, ?, 'read', ?)",
        )
        .run(randomUUID(), messageId, sessionId, now);
      const cloud = this.database.prepare("SELECT cloud_organization_id, cloud_message_id FROM messages WHERE id = ?").get(messageId);
      if (cloud) {
        const value = asRow(cloud);
        const organizationId = nullableText(value.cloud_organization_id);
        const cloudMessageId = nullableText(value.cloud_message_id);
        if (organizationId && cloudMessageId) {
          this.queueCloudReceipt(organizationId, cloudMessageId, sessionId, "surfaced");
          this.queueCloudReceipt(organizationId, cloudMessageId, sessionId, "read");
          this.database.prepare("UPDATE cloud_inbox SET state = 'read', read_at = ? WHERE organization_id = ? AND remote_message_id = ?")
            .run(now, organizationId, cloudMessageId);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createLease(input: {
    sessionId: string;
    paths: string[];
    ttlMinutes: number;
    note?: string;
  }): LeaseRecord {
    if (input.paths.length === 0) throw new Error("At least one path is required");
    if (!Number.isFinite(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > 1440) {
      throw new Error("TTL must be between 1 and 1440 minutes");
    }
    if (input.note && byteLength(input.note) > MAX_LEASE_NOTE_BYTES) throw new Error("Lease note exceeds 2 KiB");
    const paths = normalizeLeasePaths(input.paths);
    const session = this.getSession(input.sessionId);
    const now = Date.now();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO leases(
           id, owner_session_id, owner_address, repository_identity, branch,
           paths_json, note, created_at, expires_at, released_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        session.id,
        session.address,
        session.repositoryIdentity,
        session.branch,
        JSON.stringify(paths),
        input.note ? sanitizeUntrustedText(input.note) : null,
        now,
        now + input.ttlMinutes * 60_000,
      );
    return this.getLease(id);
  }

  listLeases(repositoryIdentity?: string): LeaseRecord[] {
    const conditions = ["released_at IS NULL", "expires_at > ?"];
    const values: Array<string | number> = [Date.now()];
    if (repositoryIdentity) {
      conditions.push("repository_identity = ?");
      values.push(repositoryIdentity);
    }
    return this.all(
      this.database.prepare(`SELECT * FROM leases WHERE ${conditions.join(" AND ")} ORDER BY expires_at ASC`),
      values,
    ).map((row) => this.mapLease(row));
  }

  releaseLease(leaseId: string, sessionId: string): boolean {
    const conditions = ["id = ?", "released_at IS NULL", "owner_session_id = ?"];
    const values: Array<string | number | null> = [Date.now(), leaseId, sessionId];
    const result = this.database
      .prepare(`UPDATE leases SET released_at = ? WHERE ${conditions.join(" AND ")}`)
      .run(...values);
    return Number(result.changes) > 0;
  }

  setCloudConnection(input: { organizationId: string; apiUrl: string; userId: string; deviceId: string }): CloudConnectionRecord {
    requireCloudIdentifier(input.organizationId, "Organization ID");
    requireCloudIdentifier(input.userId, "User ID");
    requireCloudIdentifier(input.deviceId, "Device ID");
    const now = Date.now();
    this.database.prepare(
      `INSERT INTO cloud_connections(organization_id, api_url, user_id, device_id, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET api_url = excluded.api_url, user_id = excluded.user_id,
         device_id = excluded.device_id, updated_at = excluded.updated_at`,
    ).run(input.organizationId, input.apiUrl, input.userId, input.deviceId, now, now);
    return this.getCloudConnection(input.organizationId) as CloudConnectionRecord;
  }

  getCloudConnection(organizationId?: string): CloudConnectionRecord | null {
    const row = organizationId
      ? this.database.prepare("SELECT * FROM cloud_connections WHERE organization_id = ?").get(organizationId)
      : this.database.prepare("SELECT * FROM cloud_connections ORDER BY updated_at DESC LIMIT 1").get();
    if (!row) return null;
    const value = asRow(row);
    return {
      organizationId: text(value.organization_id),
      apiUrl: text(value.api_url),
      userId: text(value.user_id),
      deviceId: text(value.device_id),
      connectedAt: iso(value.connected_at),
      updatedAt: iso(value.updated_at),
    };
  }

  clearCloudConnection(organizationId: string): void {
    this.database.prepare("DELETE FROM cloud_connections WHERE organization_id = ?").run(organizationId);
  }

  discardPendingCloudWork(organizationId: string): void {
    this.database.prepare("UPDATE cloud_outbox SET status = 'dead', updated_at = ?, last_error = 'discarded on disconnect' WHERE organization_id = ? AND status = 'pending'")
      .run(Date.now(), organizationId);
    this.database.prepare("UPDATE cloud_receipt_outbox SET status = 'discarded', last_error = 'discarded on disconnect' WHERE organization_id = ? AND status = 'pending'")
      .run(organizationId);
  }

  linkCloudRepository(input: { organizationId: string; repositoryId: string; repositoryIdentity: string; repositoryName: string }): CloudRepositoryLink {
    requireCloudIdentifier(input.organizationId, "Organization ID");
    requireCloudIdentifier(input.repositoryId, "Repository ID");
    if (input.repositoryIdentity.startsWith("local:")) throw new Error("Local-only repositories cannot be linked to a team");
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(
      `INSERT INTO cloud_repository_links(id, organization_id, repository_id, repository_identity, repository_name, linked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, repository_identity) DO UPDATE SET repository_id = excluded.repository_id,
         repository_name = excluded.repository_name`,
    ).run(id, input.organizationId, input.repositoryId, input.repositoryIdentity, input.repositoryName, now);
    const row = this.database.prepare(
      "SELECT * FROM cloud_repository_links WHERE organization_id = ? AND repository_identity = ?",
    ).get(input.organizationId, input.repositoryIdentity);
    return this.mapCloudRepository(asRow(row));
  }

  listCloudRepositories(organizationId: string): CloudRepositoryLink[] {
    return this.all(
      this.database.prepare("SELECT * FROM cloud_repository_links WHERE organization_id = ? ORDER BY linked_at"),
      [organizationId],
    ).map((row) => this.mapCloudRepository(row));
  }

  unlinkCloudRepository(organizationId: string, selector: string): boolean {
    const result = this.database.prepare(
      "DELETE FROM cloud_repository_links WHERE organization_id = ? AND (id = ? OR repository_id = ? OR repository_identity = ?)",
    ).run(organizationId, selector, selector, selector);
    return Number(result.changes) > 0;
  }

  cloudRepositoryForIdentity(organizationId: string, repositoryIdentity: string): CloudRepositoryLink | null {
    const row = this.database.prepare(
      "SELECT * FROM cloud_repository_links WHERE organization_id = ? AND repository_identity = ?",
    ).get(organizationId, repositoryIdentity);
    return row ? this.mapCloudRepository(asRow(row)) : null;
  }

  upsertCloudSession(organizationId: string, localSessionId: string, cloudSessionId: string, state: string): void {
    requireCloudIdentifier(organizationId, "Organization ID");
    requireCloudResourceId(cloudSessionId, "Cloud session ID");
    this.database.prepare(
      `INSERT INTO cloud_session_links(organization_id, local_session_id, cloud_session_id, last_state, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, local_session_id) DO UPDATE SET cloud_session_id = excluded.cloud_session_id,
         last_state = excluded.last_state, updated_at = excluded.updated_at`,
    ).run(organizationId, localSessionId, cloudSessionId, state, Date.now());
  }

  cloudSessionId(organizationId: string, localSessionId: string): string | null {
    const row = this.database.prepare(
      "SELECT cloud_session_id FROM cloud_session_links WHERE organization_id = ? AND local_session_id = ?",
    ).get(organizationId, localSessionId);
    return row ? text(asRow(row).cloud_session_id) : null;
  }

  cloudSessionLink(organizationId: string, localSessionId: string): { cloudSessionId: string; lastState: string } | null {
    const row = this.database.prepare(
      "SELECT cloud_session_id, last_state FROM cloud_session_links WHERE organization_id = ? AND local_session_id = ?",
    ).get(organizationId, localSessionId);
    if (!row) return null;
    const value = asRow(row);
    return { cloudSessionId: text(value.cloud_session_id), lastState: text(value.last_state) };
  }

  listCloudSessionLinks(organizationId: string): Array<{ localSessionId: string; cloudSessionId: string; lastState: string }> {
    return this.all(
      this.database.prepare("SELECT local_session_id, cloud_session_id, last_state FROM cloud_session_links WHERE organization_id = ?"),
      [organizationId],
    ).map((row) => ({ localSessionId: text(row.local_session_id), cloudSessionId: text(row.cloud_session_id), lastState: text(row.last_state) }));
  }

  cloudRemoteThreadId(organizationId: string, repositoryId: string, localThreadId: string): string | null {
    const row = this.database.prepare(
      "SELECT repository_id, remote_thread_id FROM cloud_thread_mappings WHERE organization_id = ? AND local_thread_id = ?",
    ).get(organizationId, localThreadId);
    if (!row) return null;
    const mapping = asRow(row);
    if (text(mapping.repository_id) !== repositoryId) {
      throw new Error("Cloud thread belongs to a different linked repository");
    }
    return text(mapping.remote_thread_id);
  }

  cloudLocalThreadId(organizationId: string, repositoryId: string, remoteThreadId: string): string | null {
    const row = this.database.prepare(
      "SELECT repository_id, local_thread_id FROM cloud_thread_mappings WHERE organization_id = ? AND remote_thread_id = ?",
    ).get(organizationId, remoteThreadId);
    if (!row) return null;
    const mapping = asRow(row);
    if (text(mapping.repository_id) !== repositoryId) {
      throw new Error("Cloud thread belongs to a different linked repository");
    }
    return text(mapping.local_thread_id);
  }

  recordCloudThreadMapping(organizationId: string, repositoryId: string, localThreadId: string, remoteThreadId: string): void {
    requireCloudIdentifier(organizationId, "Organization ID");
    requireCloudIdentifier(repositoryId, "Repository ID");
    requireCloudResourceId(remoteThreadId, "Remote thread ID");
    const byLocal = this.database.prepare(
      "SELECT repository_id, remote_thread_id FROM cloud_thread_mappings WHERE organization_id = ? AND local_thread_id = ?",
    ).get(organizationId, localThreadId);
    if (byLocal) {
      const current = asRow(byLocal);
      if (text(current.repository_id) !== repositoryId || text(current.remote_thread_id) !== remoteThreadId) throw new Error("Cloud thread mapping conflict");
      return;
    }
    const byRemote = this.database.prepare(
      "SELECT repository_id, local_thread_id FROM cloud_thread_mappings WHERE organization_id = ? AND remote_thread_id = ?",
    ).get(organizationId, remoteThreadId);
    if (byRemote) {
      const current = asRow(byRemote);
      if (text(current.repository_id) !== repositoryId || text(current.local_thread_id) !== localThreadId) {
        throw new Error("Cloud thread mapping conflict");
      }
    }
    this.database.prepare(
      "INSERT INTO cloud_thread_mappings(organization_id, repository_id, local_thread_id, remote_thread_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(organizationId, repositoryId, localThreadId, remoteThreadId, Date.now());
  }

  queueCloudOutbox(input: { organizationId: string; kind: string; idempotencyKey: string; payload: Record<string, unknown> }): CloudQueueRecord {
    requireCloudIdentifier(input.organizationId, "Organization ID");
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(input.idempotencyKey)) {
      throw new Error("Cloud idempotency keys must be 8-128 safe characters");
    }
    const existing = this.database.prepare(
      "SELECT * FROM cloud_outbox WHERE organization_id = ? AND idempotency_key = ?",
    ).get(input.organizationId, input.idempotencyKey);
    if (existing) {
      const queued = this.mapCloudQueue(asRow(existing));
      if (queued.kind !== input.kind || canonicalJson(queued.payload) !== canonicalJson(input.payload)) {
        throw new Error("Cloud idempotency key was already used for a different operation");
      }
      return queued;
    }
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(
      `INSERT INTO cloud_outbox(id, organization_id, kind, idempotency_key, payload_json, status, attempts, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(id, input.organizationId, input.kind, input.idempotencyKey, JSON.stringify(input.payload), now, now, now);
    return this.mapCloudQueue(asRow(this.database.prepare("SELECT * FROM cloud_outbox WHERE id = ?").get(id)));
  }

  pendingCloudOutbox(organizationId: string, now = Date.now()): CloudQueueRecord[] {
    return this.all(
      this.database.prepare("SELECT * FROM cloud_outbox WHERE organization_id = ? AND status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 100"),
      [organizationId, now],
    ).map((row) => this.mapCloudQueue(row));
  }

  markCloudOutboxSent(id: string): void {
    this.database.prepare("UPDATE cloud_outbox SET status = 'sent', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  markCloudOutboxFailed(id: string, message: string, permanent = false): void {
    const cleaned = truncateUtf8(sanitizeUntrustedText(message), 2048);
    const row = this.database.prepare("SELECT attempts FROM cloud_outbox WHERE id = ?").get(id);
    const attempts = Number(row ? asRow(row).attempts : 0) + 1;
    const dead = permanent || attempts >= 10;
    const delay = Math.min(300_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
    this.database.prepare(
      `UPDATE cloud_outbox SET attempts = ?, status = ?, last_error = ?,
       available_at = ?, updated_at = ? WHERE id = ?`,
    ).run(attempts, dead ? "dead" : "pending", cleaned, Date.now() + delay, Date.now(), id);
  }

  cloudCursor(organizationId: string, scopeKey: string): string | null {
    const row = this.database.prepare(
      "SELECT cursor FROM cloud_sync_state WHERE organization_id = ? AND scope_key = ?",
    ).get(organizationId, scopeKey);
    return row ? nullableText(asRow(row).cursor) : null;
  }

  ingestCloudInbox(input: { organizationId: string; repositoryId: string; cloudSessionId: string; nextCursor: string | null; messages: Array<Record<string, unknown>> }): number {
    requireCloudIdentifier(input.organizationId, "Organization ID");
    requireCloudIdentifier(input.repositoryId, "Repository ID");
    requireCloudResourceId(input.cloudSessionId, "Cloud session ID");
    const now = Date.now();
    let inserted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO cloud_inbox(organization_id, remote_message_id, repository_id, cloud_session_id, payload_json, state, received_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      );
      const receipt = this.database.prepare(
        `INSERT OR IGNORE INTO cloud_receipt_outbox(id, organization_id, remote_message_id, cloud_session_id, type,
          idempotency_key, status, attempts, available_at, created_at)
         VALUES (?, ?, ?, ?, 'received', ?, 'pending', 0, ?, ?)`,
      );
      for (const message of input.messages) {
        const messageId = typeof message.id === "string" ? message.id : "";
        if (!isCloudResourceId(messageId)) throw new Error("Cloud inbox message has an invalid id");
        const serialized = JSON.stringify(message);
        if (byteLength(serialized) > 64 * 1024) throw new Error("Cloud inbox message exceeds 64 KiB");
        const result = insert.run(input.organizationId, messageId, input.repositoryId, input.cloudSessionId, serialized, now);
        if (Number(result.changes) > 0) {
          inserted += 1;
          const receiptKey = createHash("sha256").update(`received\0${input.organizationId}\0${messageId}\0${input.cloudSessionId}`).digest("hex");
          receipt.run(randomUUID(), input.organizationId, messageId, input.cloudSessionId, receiptKey, now, now);
          const sessionLink = this.database.prepare(
            "SELECT local_session_id FROM cloud_session_links WHERE organization_id = ? AND cloud_session_id = ?",
          ).get(input.organizationId, input.cloudSessionId);
          if (sessionLink) this.materializeCloudMessage(input.organizationId, input.repositoryId, message, text(asRow(sessionLink).local_session_id), now);
        }
      }
      this.database.prepare(
        `INSERT INTO cloud_sync_state(organization_id, scope_key, cursor, last_synced_at, last_error)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(organization_id, scope_key) DO UPDATE SET cursor = excluded.cursor,
           last_synced_at = excluded.last_synced_at, last_error = NULL`,
      ).run(input.organizationId, `inbox:${input.repositoryId}:${input.cloudSessionId}`, input.nextCursor, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  pendingCloudReceipts(organizationId: string): CloudQueueRecord[] {
    return this.all(
      this.database.prepare(
        `SELECT id, organization_id, type AS kind, idempotency_key,
         json_object('messageId', remote_message_id, 'sessionId', cloud_session_id, 'type', type) AS payload_json,
         attempts FROM cloud_receipt_outbox current WHERE organization_id = ? AND status = 'pending' AND available_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM cloud_receipt_outbox lower
           WHERE lower.organization_id = current.organization_id
             AND lower.remote_message_id = current.remote_message_id
             AND lower.cloud_session_id = current.cloud_session_id
             AND lower.status = 'pending'
             AND (CASE lower.type WHEN 'received' THEN 1 WHEN 'surfaced' THEN 2 ELSE 3 END)
               < (CASE current.type WHEN 'received' THEN 1 WHEN 'surfaced' THEN 2 ELSE 3 END)
         )
         ORDER BY remote_message_id, cloud_session_id,
           CASE type WHEN 'received' THEN 1 WHEN 'surfaced' THEN 2 ELSE 3 END, created_at LIMIT 100`,
      ),
      [organizationId, Date.now()],
    ).map((row) => this.mapCloudQueue(row));
  }

  markCloudReceiptSent(id: string): void {
    this.database.prepare("UPDATE cloud_receipt_outbox SET status = 'sent' WHERE id = ?").run(id);
  }

  markCloudReceiptFailed(id: string, message: string, permanent = false): void {
    const cleaned = truncateUtf8(sanitizeUntrustedText(message), 2048);
    const row = this.database.prepare("SELECT attempts FROM cloud_receipt_outbox WHERE id = ?").get(id);
    const attempts = Number(row ? asRow(row).attempts : 0) + 1;
    const dead = permanent || attempts >= 10;
    const delay = Math.min(300_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
    this.database.prepare(
      "UPDATE cloud_receipt_outbox SET attempts = ?, status = ?, last_error = ?, available_at = ? WHERE id = ?",
    ).run(attempts, dead ? "dead" : "pending", cleaned, Date.now() + delay, id);
    if (dead && row) {
      const receipt = this.database.prepare("SELECT organization_id, remote_message_id, cloud_session_id FROM cloud_receipt_outbox WHERE id = ?").get(id);
      if (receipt) {
        const value = asRow(receipt);
        this.database.prepare(
          "UPDATE cloud_receipt_outbox SET status = 'dead', last_error = ? WHERE organization_id = ? AND remote_message_id = ? AND cloud_session_id = ? AND status = 'pending'",
        ).run(cleaned, text(value.organization_id), text(value.remote_message_id), text(value.cloud_session_id));
      }
    }
  }

  supersedeCloudDelivery(organizationId: string, messageId: string, cloudSessionId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "UPDATE cloud_receipt_outbox SET status = 'discarded', last_error = 'delivery superseded' WHERE organization_id = ? AND remote_message_id = ? AND cloud_session_id = ? AND status = 'pending'",
      ).run(organizationId, messageId, cloudSessionId);
      this.database.prepare(
        "UPDATE cloud_inbox SET state = 'superseded' WHERE organization_id = ? AND remote_message_id = ? AND cloud_session_id = ?",
      ).run(organizationId, messageId, cloudSessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private queueCloudReceipt(organizationId: string, messageId: string, localSessionId: string, type: "surfaced" | "read"): void {
    const cloudSessionId = this.cloudSessionId(organizationId, localSessionId);
    if (!cloudSessionId) return;
    const now = Date.now();
    const idempotencyKey = createHash("sha256").update(`${type}\0${organizationId}\0${messageId}\0${cloudSessionId}`).digest("hex");
    this.database.prepare(
      `INSERT OR IGNORE INTO cloud_receipt_outbox(id, organization_id, remote_message_id, cloud_session_id, type,
       idempotency_key, status, attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(randomUUID(), organizationId, messageId, cloudSessionId, type, idempotencyKey, now, now);
  }

  private materializeCloudMessage(organizationId: string, repositoryId: string, message: Record<string, unknown>, localSessionId: string, now: number): void {
    const remoteId = typeof message.id === "string" ? message.id : "";
    const body = typeof message.body === "string" ? sanitizeUntrustedText(message.body) : "";
    if (!remoteId || !body || byteLength(body) > MAX_MESSAGE_BYTES) throw new Error("Cloud inbox message has invalid content");
    if (message.repositoryId !== repositoryId) {
      throw new Error("Cloud inbox message provenance does not match the requested repository");
    }
    const remoteThreadId = isCloudResourceId(message.threadId) ? message.threadId : "";
    if (!remoteThreadId) throw new Error("Cloud inbox message has an invalid thread id");
    const threadId = this.cloudLocalThreadId(organizationId, repositoryId, remoteThreadId)
      ?? namespacedUuid(`cloud-thread:${organizationId}`, remoteThreadId);
    this.recordCloudThreadMapping(organizationId, repositoryId, threadId, remoteThreadId);
    const sender = message.sender && typeof message.sender === "object" && !Array.isArray(message.sender)
      ? message.sender as Record<string, unknown>
      : {};
    if (![sender.userId, sender.deviceId].every((value) => typeof value === "string" && CLOUD_IDENTIFIER_PATTERN.test(value))
      || !isCloudResourceId(sender.sessionId)
      || typeof sender.provider !== "string" || !CLOUD_IDENTIFIER_PATTERN.test(sender.provider)
      || typeof sender.branch !== "string" || sender.branch.length < 1 || sender.branch.length > 512) {
      throw new Error("Cloud inbox message is missing authenticated sender provenance");
    }
    const senderUserId = sender.userId as string;
    const senderDeviceId = sender.deviceId as string;
    const senderSessionId = sender.sessionId;
    const senderProvider = sender.provider;
    const senderBranch = sender.branch;
    const senderRepository = typeof sender.repositoryId === "string"
      ? sender.repositoryId
      : typeof message.repositoryId === "string" ? message.repositoryId : repositoryId;
    const safeAddressPart = (value: string): string => sanitizeUntrustedText(value).replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 256) || "unknown";
    const senderAddress = `team/${safeAddressPart(organizationId)}/${safeAddressPart(senderUserId)}/${safeAddressPart(senderDeviceId)}/${safeAddressPart(senderProvider)}@${safeAddressPart(senderRepository)}#${safeAddressPart(senderBranch)}~${safeAddressPart(senderSessionId)}`;
    const recipient = this.getSession(localSessionId);
    this.database.prepare(
      `INSERT INTO threads(id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(threadId, now, now);
    this.database.prepare(
      `INSERT OR IGNORE INTO messages(id, thread_id, sender_session_id, sender_address, recipient_session_id,
       recipient_address, body, status, created_at, idempotency_key, cloud_organization_id, cloud_message_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?)`,
    ).run(randomUUID(), threadId, senderAddress, recipient.id, recipient.address, body, now, organizationId, remoteId);
  }

  cloudQueueStatus(organizationId: string): { outboxPending: number; outboxDead: number; inboxQueued: number; receiptsPending: number; receiptsDead: number; lastSyncedAt: string | null } {
    const count = (table: string, condition: string): number => Number(asRow(this.database.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE organization_id = ? AND ${condition}`,
    ).get(organizationId)).count);
    const last = this.database.prepare("SELECT MAX(last_synced_at) AS value FROM cloud_sync_state WHERE organization_id = ?").get(organizationId);
    const value = last ? asRow(last).value : null;
    return {
      outboxPending: count("cloud_outbox", "status = 'pending'"),
      outboxDead: count("cloud_outbox", "status = 'dead'"),
      inboxQueued: count("cloud_inbox", "state = 'queued'"),
      receiptsPending: count("cloud_receipt_outbox", "status = 'pending'"),
      receiptsDead: count("cloud_receipt_outbox", "status = 'dead'"),
      lastSyncedAt: value === null || value === undefined ? null : iso(value),
    };
  }

  status(version: string, startedAt: number): DaemonStatus {
    this.refreshPresenceStates();
    const stateCounts = this.all(
      this.database.prepare("SELECT state, COUNT(*) AS count FROM sessions GROUP BY state"),
      [],
    );
    const counts = new Map(stateCounts.map((row) => [text(row.state), Number(row.count)]));
    const unread = asRow(this.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE status != 'read'").get());
    const leases = asRow(
      this.database.prepare("SELECT COUNT(*) AS count FROM leases WHERE released_at IS NULL AND expires_at > ?").get(Date.now()),
    );
    return {
      version,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      sessions: {
        active: counts.get("active") ?? 0,
        idle: counts.get("idle") ?? 0,
        stale: counts.get("stale") ?? 0,
      },
      unreadMessages: Number(unread.count),
      activeLeases: Number(leases.count),
      databasePath: this.paths.database,
    };
  }

  private getMessage(id: string): MessageRecord {
    const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    if (!row) throw new Error(`Message ${id} was not found`);
    return this.mapMessage(asRow(row));
  }

  private getLease(id: string): LeaseRecord {
    const row = this.database.prepare("SELECT * FROM leases WHERE id = ?").get(id);
    if (!row) throw new Error(`Lease ${id} was not found`);
    return this.mapLease(asRow(row));
  }

  private all(statement: StatementSync, values: Array<string | number | null>): SqlRow[] {
    return statement.all(...values).map(asRow);
  }

  private mapSession(row: SqlRow): SessionRecord {
    return {
      id: text(row.id),
      address: text(row.address),
      provider: text(row.provider) as SessionRecord["provider"],
      providerSessionId: nullableText(row.provider_session_id),
      repositoryIdentity: text(row.repository_identity),
      repositoryName: text(row.repository_name),
      repositoryRoot: text(row.repository_root),
      branch: text(row.branch),
      taskLabel: nullableText(row.task_label),
      pid: nullableNumber(row.pid),
      state: text(row.state) as SessionRecord["state"],
      startedAt: iso(row.started_at),
      lastActiveAt: iso(row.last_active_at),
      endedAt: optionalIso(row.ended_at),
    };
  }

  private mapMessage(row: SqlRow): MessageRecord {
    return {
      id: text(row.id),
      threadId: text(row.thread_id),
      senderSessionId: nullableText(row.sender_session_id),
      senderAddress: text(row.sender_address),
      recipientSessionId: text(row.recipient_session_id),
      recipientAddress: text(row.recipient_address),
      body: text(row.body),
      status: text(row.status) as MessageRecord["status"],
      createdAt: iso(row.created_at),
      surfacedAt: optionalIso(row.surfaced_at),
      readAt: optionalIso(row.read_at),
    };
  }

  private mapLease(row: SqlRow): LeaseRecord {
    return {
      id: text(row.id),
      ownerSessionId: text(row.owner_session_id),
      ownerAddress: text(row.owner_address),
      repositoryIdentity: text(row.repository_identity),
      branch: text(row.branch),
      paths: JSON.parse(text(row.paths_json)) as string[],
      note: nullableText(row.note),
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      releasedAt: optionalIso(row.released_at),
    };
  }

  private mapCloudRepository(row: SqlRow): CloudRepositoryLink {
    return {
      id: text(row.id),
      organizationId: text(row.organization_id),
      repositoryId: text(row.repository_id),
      repositoryIdentity: text(row.repository_identity),
      repositoryName: text(row.repository_name),
      linkedAt: iso(row.linked_at),
    };
  }

  private mapCloudQueue(row: SqlRow): CloudQueueRecord {
    const parsed = JSON.parse(text(row.payload_json)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Cloud queue payload is invalid");
    return {
      id: text(row.id),
      organizationId: text(row.organization_id),
      kind: text(row.kind),
      idempotencyKey: text(row.idempotency_key),
      payload: parsed as Record<string, unknown>,
      attempts: Number(row.attempts),
    };
  }
}
