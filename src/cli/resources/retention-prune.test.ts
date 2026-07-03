/**
 * Fixture tests for the `retention_prune` host-only CLI command (Circle M21,
 * workstream d's spine piece) — real session/task/archive fixtures under a
 * temp data dir (`config.js` DATA_DIR/GROUPS_DIR patched, mirrors
 * `groups.test.ts` and `erase-user.test.ts`). No per-user targeting here —
 * every case is an AGE cutoff, so the load-bearing assertion throughout is
 * the AGE GUARD: a row/dir on the near side of the window must survive.
 *
 * The temp dir is created once (`beforeAll`) and removed once (`afterAll`,
 * best-effort) — every fixture-writing test uses its own uniquely-named
 * agent/session/dir, so no cross-test cleanup is needed (see erase-user.test.ts
 * for why per-test rm was dropped: a Windows-only same-process file-lock race).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// `vi.mock` factories are hoisted above top-level const declarations, so the
// paths are literal here (mirrors groups.test.ts's DATA_DIR override) — kept
// in sync with the TEST_* constants below by convention.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-retention-prune/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-retention-prune/groups',
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-retention-prune';
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');

import { ensureSchema } from '../../db/session-db.js';
import type { CallerContext } from '../frame.js';
import { parseRetentionPruneArgs, retentionPrune } from './retention-prune.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT_CALLER: CallerContext = {
  caller: 'agent',
  agentGroupId: 'ag-evil',
  sessionId: 'sess-x',
  messagingGroupId: 'mg-x',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_ENV = { ...process.env };

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

/** Creates DATA_DIR/v2-sessions/<agentGroupId>/<sessionId>/{inbound,outbound}.db with one row each at the given age. */
function writeSessionFixture(agentGroupId: string, sessionId: string, daysAgo: number): void {
  const sessionDir = path.join(TEST_DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const ts = iso(daysAgo);

  const inboundPath = path.join(sessionDir, 'inbound.db');
  ensureSchema(inboundPath, 'inbound');
  const inDb = new Database(inboundPath);
  inDb
    .prepare(`INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, 2, 'chat', ?, '{}')`)
    .run(`min-${sessionId}`, ts);
  inDb.close();

  const outboundPath = path.join(sessionDir, 'outbound.db');
  ensureSchema(outboundPath, 'outbound');
  const outDb = new Database(outboundPath);
  outDb
    .prepare(`INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, 1, 'chat', ?, '{}')`)
    .run(`mout-${sessionId}`, ts);
  outDb.close();
}

function countTable(dbPath: string, table: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function withTasksDb<T>(fn: (db: Database.Database) => T): T {
  const dbPath = path.join(TEST_DATA_DIR, 'tasklist', 'tasks.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo', parent_task_id TEXT, blocked_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    return fn(db);
  } finally {
    db.close();
  }
}

function writeArchiveFixture(groupFolder: string, name: string, daysAgo: number): string {
  const dir = path.join(TEST_GROUPS_DIR, groupFolder, 'archive', `${name}__${Date.now() - daysAgo * DAY_MS}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), 'x');
  return dir;
}

describe('parseRetentionPruneArgs', () => {
  it('defaults classes to undefined (all) and dryRun to false', () => {
    expect(parseRetentionPruneArgs({})).toEqual({ dryRun: false });
  });

  it('accepts a valid classes array + dryRun', () => {
    expect(parseRetentionPruneArgs({ classes: ['chat', 'tasks'], dryRun: true })).toEqual({
      classes: ['chat', 'tasks'],
      dryRun: true,
    });
  });

  it('rejects an invalid class name', () => {
    expect(() => parseRetentionPruneArgs({ classes: ['chat', 'bogus'] })).toThrow(/invalid retention class/);
  });

  it('rejects a non-array classes value', () => {
    expect(() => parseRetentionPruneArgs({ classes: 'chat' })).toThrow(/must be an array/);
  });
});

describe('retention_prune', () => {
  // Every prune sweep here is GLOBAL/age-based by design (no per-user scoping —
  // see the header comment), so — unlike erase-user.test.ts — fixtures from one
  // test WOULD be visible to the next unless the temp dir is reset per test.
  // All helpers close their DB handles (countTable/withTasksDb), so this
  // doesn't hit the Windows same-process file-lock race that made per-test rm
  // unreliable there.
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    // Deterministic windows for every test unless a test overrides one itself.
    process.env.RETENTION_PRUNE_CHAT_DAYS = '365';
    process.env.RETENTION_PRUNE_TASKS_DAYS = '365';
    process.env.RETENTION_PRUNE_ARCHIVE_DAYS = '90';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects a non-host caller', async () => {
    const r = await retentionPrune({ dryRun: false }, AGENT_CALLER);
    expect(r).toMatchObject({ ok: false, error: 'not-host' });
  });

  it('prunes chat rows past the window — a within-window session (age guard) survives', async () => {
    writeSessionFixture('ag-chat-old', 'sess-1', 400); // past the 365d default
    writeSessionFixture('ag-chat-recent', 'sess-1', 10); // well within the window

    const r = await retentionPrune({ classes: ['chat'], dryRun: false }, HOST);
    expect(r).toMatchObject({ ok: true, perClass: { chat: { pruned: 2 } } }); // 1 in + 1 out for the old session

    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-chat-old', 'sess-1', 'inbound.db'), 'messages_in'),
    ).toBe(0);
    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-chat-old', 'sess-1', 'outbound.db'), 'messages_out'),
    ).toBe(0);
    // The recent session's rows survive untouched — the age guard.
    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-chat-recent', 'sess-1', 'inbound.db'), 'messages_in'),
    ).toBe(1);
    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-chat-recent', 'sess-1', 'outbound.db'), 'messages_out'),
    ).toBe(1);
  });

  it('prunes only status=done tasks past the window — open work + recent done rows survive', async () => {
    withTasksDb((db) => {
      db.prepare(
        `INSERT INTO tasks (id, agent_group_id, title, status, created_at, updated_at) VALUES ('t-old-done', 'ag-x', 'x', 'done', ?, ?)`,
      ).run(iso(400), iso(400));
      db.prepare(
        `INSERT INTO tasks (id, agent_group_id, title, status, created_at, updated_at) VALUES ('t-recent-done', 'ag-x', 'x', 'done', ?, ?)`,
      ).run(iso(400), iso(10));
      // Old but still open — must NEVER be pruned regardless of age.
      db.prepare(
        `INSERT INTO tasks (id, agent_group_id, title, status, created_at, updated_at) VALUES ('t-old-open', 'ag-x', 'x', 'todo', ?, ?)`,
      ).run(iso(400), iso(400));
    });

    const r = await retentionPrune({ classes: ['tasks'], dryRun: false }, HOST);
    expect(r).toMatchObject({ ok: true, perClass: { tasks: { pruned: 1 } } });

    withTasksDb((db) => {
      const remaining = db.prepare(`SELECT id FROM tasks ORDER BY id`).all() as Array<{ id: string }>;
      expect(remaining.map((t) => t.id).sort()).toEqual(['t-old-open', 't-recent-done']);
    });
  });

  it('prunes archive dirs past the window — a within-window archive (age guard) survives', async () => {
    const oldDir = writeArchiveFixture('prune-main', 'old__sub-a', 100); // past the 90d default
    const recentDir = writeArchiveFixture('prune-main', 'recent__sub-b', 10); // within the window

    const r = await retentionPrune({ classes: ['archive'], dryRun: false }, HOST);
    expect(r).toMatchObject({ ok: true, perClass: { archive: { pruned: 1 } } });

    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it('dryRun counts only — nothing is mutated across all three classes', async () => {
    writeSessionFixture('ag-dryrun-chat', 'sess-1', 400);
    withTasksDb((db) => {
      db.prepare(
        `INSERT INTO tasks (id, agent_group_id, title, status, created_at, updated_at) VALUES ('t-dryrun', 'ag-dryrun', 'x', 'done', ?, ?)`,
      ).run(iso(400), iso(400));
    });
    const archiveDir = writeArchiveFixture('dryrun-main', 'old__sub-c', 100);

    const r = await retentionPrune({ dryRun: true }, HOST);
    expect(r).toMatchObject({
      ok: true,
      perClass: { chat: { pruned: 2 }, tasks: { pruned: 1 }, archive: { pruned: 1 } },
    });

    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-dryrun-chat', 'sess-1', 'inbound.db'), 'messages_in'),
    ).toBe(1);
    withTasksDb((db) => {
      expect(db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE id = 't-dryrun'`).get()).toMatchObject({ c: 1 });
    });
    expect(fs.existsSync(archiveDir)).toBe(true);
  });

  it('only runs the requested classes — omitted classes are untouched and absent from perClass', async () => {
    writeSessionFixture('ag-scoped-chat', 'sess-1', 400);
    withTasksDb((db) => {
      db.prepare(
        `INSERT INTO tasks (id, agent_group_id, title, status, created_at, updated_at) VALUES ('t-scoped', 'ag-scoped', 'x', 'done', ?, ?)`,
      ).run(iso(400), iso(400));
    });

    const r = await retentionPrune({ classes: ['tasks'], dryRun: false }, HOST);
    expect(r).toMatchObject({ ok: true, perClass: { tasks: { pruned: 1 } } });
    if (r.ok) {
      expect(r.perClass.chat).toBeUndefined();
      expect(r.perClass.archive).toBeUndefined();
    }

    // Chat class was NOT selected — the old row survives even past its window.
    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-scoped-chat', 'sess-1', 'inbound.db'), 'messages_in'),
    ).toBe(1);
  });

  it('honors the RETENTION_PRUNE_ARCHIVE_DAYS env override', async () => {
    process.env.RETENTION_PRUNE_ARCHIVE_DAYS = '5'; // shrink the window
    const dir = writeArchiveFixture('env-override-main', 'old__sub-d', 10); // now past the shrunk window

    const r = await retentionPrune({ classes: ['archive'], dryRun: false }, HOST);
    expect(r).toMatchObject({ ok: true, perClass: { archive: { pruned: 1 } } });
    expect(fs.existsSync(dir)).toBe(false);
  });
});
