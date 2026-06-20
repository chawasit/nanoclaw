/**
 * Task-list module DB — a STANDALONE host-owned SQLite file
 * (`data/tasklist/tasks.db`), separate from the central `v2.db`.
 *
 * Why standalone + its own directory: this DB is bind-mounted READ-ONLY into
 * agent containers so they can read the board (the `additional_mounts` pattern,
 * like the SOP vault). Mounting `data/` itself would expose `v2.db` + every
 * session DB, so the file lives in its own `data/tasklist/` directory and only
 * that directory is mounted.
 *
 * `journal_mode=DELETE` (NOT WAL): committed writes must be visible to a
 * read-only cross-mount reader. WAL parks committed data in a `-wal` sidecar a
 * read-only mount can't replay — the repo's session DBs use DELETE for exactly
 * this reason (see host CLAUDE.md). The central `v2.db` uses WAL; do not copy
 * that here. (Verified live: container reads a DELETE-mode db over a `:ro`
 * mount cleanly — dev-log/0013 Step 0.)
 *
 * The host is the ONLY writer — single-writer-per-file invariant preserved.
 * CRUD fns take an explicit `db` so they're unit-testable against an in-memory
 * DB (mirrors `src/modules/scheduling/db.ts`); `actions.ts` passes
 * `getTasklistDb()`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

export const TASKLIST_DIR = path.join(DATA_DIR, 'tasklist');
export const TASKLIST_DB_PATH = path.join(TASKLIST_DIR, 'tasks.db');

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
export const AGENT_STATES = ['working', 'blocked', 'idle', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentState = (typeof AGENT_STATES)[number];

const TASK_STATUS_SET = new Set<string>(TASK_STATUSES);
const AGENT_STATE_SET = new Set<string>(AGENT_STATES);

// DDL is embedded (not read from the Circle repo's schema.sql) because the
// fork can't reach that file at runtime. Keep in sync with
// company/services/task-list/schema.sql.
const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo','doing','blocked','done')),
  parent_task_id TEXT REFERENCES tasks(id),
  blocked_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_group  ON tasks(agent_group_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE IF NOT EXISTS statuses (
  agent_group_id TEXT PRIMARY KEY,
  state          TEXT NOT NULL DEFAULT 'idle'
                   CHECK (state IN ('working','blocked','idle','done')),
  summary        TEXT,
  blockers       TEXT,
  eta            TEXT,
  updated_at     TEXT NOT NULL
);
`;

/** Apply the schema to any DB handle (exported for tests). Idempotent. */
export function applySchema(db: Database.Database): void {
  db.exec(DDL);
}

let _db: Database.Database | null = null;

export function initTasklistDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(TASKLIST_DIR, { recursive: true });
  const db = new Database(TASKLIST_DB_PATH);
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  _db = db;
  log.info('Task-list DB initialized', { path: TASKLIST_DB_PATH });
  return _db;
}

export function getTasklistDb(): Database.Database {
  return _db ?? initTasklistDb();
}

export interface NewTask {
  id: string;
  agentGroupId: string;
  title: string;
  parentTaskId: string | null;
}

export function insertTask(db: Database.Database, t: NewTask): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, agent_group_id, title, status, parent_task_id, created_at, updated_at)
     VALUES (@id, @agentGroupId, @title, 'todo', @parentTaskId, @now, @now)`,
  ).run({ id: t.id, agentGroupId: t.agentGroupId, title: t.title, parentTaskId: t.parentTaskId, now });
}

export interface TaskPatch {
  status?: string;
  blockedReason?: string | null;
}

/**
 * Patch a task. Scoped to the owning `agentGroupId` so an agent can only mutate
 * its own tasks (defense in depth — the host already attributes ownership from
 * the trusted session identity). Returns rows touched (0 = no match / not owner).
 * Throws on an invalid status value.
 */
export function updateTask(db: Database.Database, id: string, agentGroupId: string, patch: TaskPatch): number {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    if (!TASK_STATUS_SET.has(patch.status)) throw new Error(`invalid task status: ${patch.status}`);
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.blockedReason !== undefined) {
    sets.push('blocked_reason = ?');
    params.push(patch.blockedReason);
  }
  if (sets.length === 0) return 0;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id, agentGroupId);
  const res = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND agent_group_id = ?`).run(...params);
  return res.changes;
}

export interface NewStatus {
  agentGroupId: string;
  state: string;
  summary: string | null;
  blockers: string | null;
  eta: string | null;
}

/** Upsert the latest-per-agent status row (the standup board). Throws on an invalid state. */
export function upsertStatus(db: Database.Database, s: NewStatus): void {
  if (!AGENT_STATE_SET.has(s.state)) throw new Error(`invalid agent state: ${s.state}`);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO statuses (agent_group_id, state, summary, blockers, eta, updated_at)
     VALUES (@agentGroupId, @state, @summary, @blockers, @eta, @now)
     ON CONFLICT(agent_group_id) DO UPDATE SET
       state = excluded.state,
       summary = excluded.summary,
       blockers = excluded.blockers,
       eta = excluded.eta,
       updated_at = excluded.updated_at`,
  ).run({
    agentGroupId: s.agentGroupId,
    state: s.state,
    summary: s.summary,
    blockers: s.blockers,
    eta: s.eta,
    now,
  });
}
