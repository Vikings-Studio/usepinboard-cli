import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_STALE_MINUTES,
  MAX_LEASE_NOTE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_TASK_LABEL_BYTES,
} from "../constants.js";
import { makeAddress } from "../domain/repository.js";
import type {
  DaemonStatus,
  LeaseRecord,
  MessageRecord,
  SessionInput,
  SessionRecord,
} from "../domain/types.js";
import { ensureDirectories, getPaths, type PinboardPaths } from "../platform/paths.js";
import { normalizeLeasePaths } from "../security/lease-path.js";
import { sanitizeUntrustedText } from "../security/untrusted.js";
import { SCHEMA_MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

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

export class PinboardDatabase {
  readonly paths: PinboardPaths;
  readonly database: DatabaseSync;

  private constructor(paths: PinboardPaths, database: DatabaseSync) {
    this.paths = paths;
    this.database = database;
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
    return new PinboardDatabase(paths, database);
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

  registerSession(input: SessionInput): SessionRecord {
    const now = Date.now();
    const taskLabel = input.taskLabel ? sanitizeUntrustedText(input.taskLabel).slice(0, MAX_TASK_LABEL_BYTES) : null;
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET
             address = excluded.address,
             provider = excluded.provider,
             provider_session_id = excluded.provider_session_id,
             repository_identity = excluded.repository_identity,
             branch = excluded.branch,
             task_label = COALESCE(excluded.task_label, sessions.task_label),
             pid = excluded.pid,
             state = 'active',
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
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getSession(input.id);
  }

  heartbeat(sessionId: string, taskLabel?: string): SessionRecord {
    const cleaned = taskLabel ? sanitizeUntrustedText(taskLabel).slice(0, MAX_TASK_LABEL_BYTES) : null;
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
    const idleCutoff = now - DEFAULT_IDLE_MINUTES * 60_000;
    const staleCutoff = now - DEFAULT_STALE_MINUTES * 60_000;
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

  sendMessage(input: {
    senderSessionId?: string;
    to: string;
    body: string;
    threadId?: string;
  }): { message: MessageRecord; alternatives: SessionRecord[] } {
    if (!input.body.trim()) throw new Error("Message cannot be empty");
    if (byteLength(input.body) > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 32 KiB");
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
             recipient_address, body, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
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
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { message: this.getMessage(id), alternatives: matches.slice(1) };
  }

  inbox(input: { sessionId: string; unreadOnly?: boolean; limit?: number }): MessageRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const conditions = ["recipient_session_id = ?"];
    const values: Array<string | number> = [input.sessionId];
    if (input.unreadOnly) conditions.push("status != 'read'");
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
    for (const row of rows) update.run(surfacedAt, text(row.id));
    return rows.map((row) => this.getMessage(text(row.id)));
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

  releaseLease(leaseId: string, sessionId?: string): boolean {
    const conditions = ["id = ?", "released_at IS NULL"];
    const values: Array<string | number | null> = [Date.now(), leaseId];
    if (sessionId) {
      conditions.push("owner_session_id = ?");
      values.push(sessionId);
    }
    const result = this.database
      .prepare(`UPDATE leases SET released_at = ? WHERE ${conditions.join(" AND ")}`)
      .run(...values);
    return Number(result.changes) > 0;
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
}
