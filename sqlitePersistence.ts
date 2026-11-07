import { DatabaseSync } from 'node:sqlite';
import {
  ActivitySession,
  NodeRecord,
  UserRecord,
  XPEntry,
  LocationObservation,
  CanonicalEventRecord,
} from './canonicalDomain';
import {
  PersistenceSnapshot,
  ProcessingSession,
  SessionPersistence,
  SessionPersistenceTransaction,
} from './sessionProcessor';

const SCHEMA_VERSION = 1;

type SqlRow = Record<string, unknown>;

export class SQLiteSessionPersistence implements SessionPersistence {
  readonly db: DatabaseSync;
  private readonly fileName: string;

  constructor(fileName: string) {
    this.fileName = fileName;
    this.db = new DatabaseSync(fileName);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('created','active','completed')),
        activity_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (idempotency_key),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (idempotency_key),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE IF NOT EXISTS xp_entries (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('walking','presence','participation')),
        economy_scope TEXT NOT NULL,
        economy_version TEXT NOT NULL,
        awarded_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (idempotency_key),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE IF NOT EXISTS http_replays (
        replay_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        route TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY (replay_key, user_id, route)
      );
    `);
    const existing = this.db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
    ).get() as SqlRow | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (Number(existing.version) !== SCHEMA_VERSION) {
      throw new Error(`Unsupported SQLite schema version: ${String(existing.version)}`);
    }
  }

  snapshot(): PersistenceSnapshot {
    const users = (this.db.prepare('SELECT record_json FROM users ORDER BY id').all() as SqlRow[])
      .map((row) => JSON.parse(String(row.record_json)) as UserRecord);
    const nodes = (this.db.prepare('SELECT record_json FROM nodes ORDER BY id').all() as SqlRow[])
      .map((row) => JSON.parse(String(row.record_json)) as NodeRecord);
    const sessions = (this.db.prepare(
      'SELECT lifecycle, activity_json FROM sessions ORDER BY started_at, id',
    ).all() as SqlRow[]).map((row) => ({
      lifecycle: String(row.lifecycle) as ProcessingSession['lifecycle'],
      activity: JSON.parse(String(row.activity_json)) as ActivitySession,
    }));
    const observations = (this.db.prepare(
      'SELECT record_json FROM observations ORDER BY observed_at, id',
    ).all() as SqlRow[]).map((row) =>
      JSON.parse(String(row.record_json)) as LocationObservation);
    const events = (this.db.prepare(
      'SELECT record_json FROM events ORDER BY occurred_at, id',
    ).all() as SqlRow[]).map((row) =>
      JSON.parse(String(row.record_json)) as CanonicalEventRecord);
    const xpEntries = (this.db.prepare(
      'SELECT record_json FROM xp_entries ORDER BY awarded_at, id',
    ).all() as SqlRow[]).map((row) =>
      JSON.parse(String(row.record_json)) as XPEntry);
    return { users, nodes, sessions, observations, events, xpEntries };
  }

  transaction<T>(work: (transaction: SessionPersistenceTransaction) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const staged = this.snapshot();
    let result: T;
    const transaction: SessionPersistenceTransaction = {
      snapshot: staged,
      saveUser: (user) => {
        this.db.prepare(
          'INSERT INTO users(id, record_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
        ).run(user.id, JSON.stringify(user), user.createdAt, user.updatedAt);
        staged.users = [...staged.users.filter((item) => item.id !== user.id), user];
      },
      saveNode: (node) => {
        this.db.prepare(
          'INSERT INTO nodes(id, record_json) VALUES (?, ?)',
        ).run(node.id, JSON.stringify(node));
        staged.nodes = [...staged.nodes.filter((item) => item.id !== node.id), node];
      },
      saveSession: (session) => {
        this.db.prepare(
          `INSERT INTO sessions(id,user_id,lifecycle,activity_json,started_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          session.activity.id,
          session.activity.userId,
          session.lifecycle,
          JSON.stringify(session.activity),
          session.activity.startedAt,
        );
        staged.sessions = [...staged.sessions, session];
      },
      replaceSession: (session) => {
        this.db.prepare(
          `UPDATE sessions SET lifecycle=?, activity_json=? WHERE id=? AND user_id=?`,
        ).run(session.lifecycle, JSON.stringify(session.activity), session.activity.id, session.activity.userId);
        staged.sessions = staged.sessions.map((item) =>
          item.activity.id === session.activity.id ? session : item);
      },
      saveObservation: (observation) => {
        this.db.prepare(
          `INSERT INTO observations(id,idempotency_key,user_id,session_id,observed_at,record_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          observation.id, observation.idempotencyKey, observation.userId,
          observation.sessionId, observation.observedAt, JSON.stringify(observation),
        );
        staged.observations = [...staged.observations, observation];
      },
      saveEvent: (event) => {
        this.db.prepare(
          `INSERT INTO events(id,idempotency_key,user_id,session_id,occurred_at,record_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          event.id, event.idempotencyKey, event.userId, event.sessionId,
          event.occurredAt, JSON.stringify(event),
        );
        staged.events = [...staged.events, event];
      },
      saveXPEntry: (entry) => {
        this.db.prepare(
          `INSERT INTO xp_entries(id,idempotency_key,user_id,session_id,category,economy_scope,economy_version,awarded_at,record_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.id, entry.idempotencyKey, entry.userId,
          entry.source.activitySessionId, entry.category,
          entry.economyVersion.scope, entry.economyVersion.version,
          entry.awardedAt, JSON.stringify(entry),
        );
        staged.xpEntries = [...staged.xpEntries, entry];
      },
    };

    try {
      result = work(transaction);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getFileName(): string {
    return this.fileName;
  }
}
