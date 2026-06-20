/**
 * Tests for the task-list module DB helpers — ownership-scoped updates, the
 * status CHECK constraints, and the statuses UPSERT (latest-per-agent board).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { applySchema, insertTask, updateTask, upsertStatus } from './db.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
});

afterEach(() => {
  db.close();
});

function countTasks(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
}

describe('insertTask', () => {
  it('creates a task in todo status owned by the agent group', () => {
    insertTask(db, { id: 't1', agentGroupId: 'ag-A', title: 'ship it', parentTaskId: null });
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(row.status).toBe('todo');
    expect(row.agent_group_id).toBe('ag-A');
    expect(row.title).toBe('ship it');
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  it('supports a subtask parent reference', () => {
    insertTask(db, { id: 'p1', agentGroupId: 'ag-A', title: 'parent', parentTaskId: null });
    insertTask(db, { id: 'c1', agentGroupId: 'ag-A', title: 'child', parentTaskId: 'p1' });
    const row = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get('c1') as {
      parent_task_id: string;
    };
    expect(row.parent_task_id).toBe('p1');
  });
});

describe('updateTask', () => {
  beforeEach(() => {
    insertTask(db, { id: 't1', agentGroupId: 'ag-A', title: 'ship it', parentTaskId: null });
  });

  it('patches status for the owning agent and returns 1', () => {
    const touched = updateTask(db, 't1', 'ag-A', { status: 'doing' });
    expect(touched).toBe(1);
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1') as { status: string };
    expect(row.status).toBe('doing');
  });

  it('refuses to patch a task owned by another agent (returns 0)', () => {
    const touched = updateTask(db, 't1', 'ag-B', { status: 'done' });
    expect(touched).toBe(0);
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1') as { status: string };
    expect(row.status).toBe('todo');
  });

  it('records a blocked reason alongside a status change', () => {
    updateTask(db, 't1', 'ag-A', { status: 'blocked', blockedReason: 'waiting on API key' });
    const row = db.prepare('SELECT status, blocked_reason FROM tasks WHERE id = ?').get('t1') as {
      status: string;
      blocked_reason: string;
    };
    expect(row.status).toBe('blocked');
    expect(row.blocked_reason).toBe('waiting on API key');
  });

  it('throws on an invalid status value', () => {
    expect(() => updateTask(db, 't1', 'ag-A', { status: 'wip' })).toThrow(/invalid task status/);
  });

  it('is a no-op (returns 0) when no fields are given', () => {
    expect(updateTask(db, 't1', 'ag-A', {})).toBe(0);
  });
});

describe('upsertStatus', () => {
  it('inserts then updates the same row (latest-per-agent board)', () => {
    upsertStatus(db, { agentGroupId: 'ag-A', state: 'working', summary: 'on it', blockers: null, eta: '1h' });
    let row = db.prepare('SELECT * FROM statuses WHERE agent_group_id = ?').get('ag-A') as Record<string, unknown>;
    expect(row.state).toBe('working');
    expect(row.summary).toBe('on it');

    upsertStatus(db, {
      agentGroupId: 'ag-A',
      state: 'blocked',
      summary: 'stuck',
      blockers: 'need creds',
      eta: null,
    });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM statuses').get() as { n: number }).n;
    expect(count).toBe(1); // upsert, not append
    row = db.prepare('SELECT * FROM statuses WHERE agent_group_id = ?').get('ag-A') as Record<string, unknown>;
    expect(row.state).toBe('blocked');
    expect(row.blockers).toBe('need creds');
    expect(row.eta).toBeNull();
  });

  it('keeps separate rows per agent', () => {
    upsertStatus(db, { agentGroupId: 'ag-A', state: 'working', summary: null, blockers: null, eta: null });
    upsertStatus(db, { agentGroupId: 'ag-B', state: 'idle', summary: null, blockers: null, eta: null });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM statuses').get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it('throws on an invalid state value', () => {
    expect(() =>
      upsertStatus(db, { agentGroupId: 'ag-A', state: 'sleeping', summary: null, blockers: null, eta: null }),
    ).toThrow(/invalid agent state/);
  });
});

describe('schema', () => {
  it('is idempotent (applySchema twice is safe)', () => {
    applySchema(db);
    expect(countTasks()).toBe(0);
  });
});
