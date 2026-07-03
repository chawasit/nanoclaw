/**
 * Fixture tests for the `erase_user` host-only CLI command (Circle M21) — a
 * real in-memory v2.db (migrations applied, like db-v2.test.ts) PLUS a real
 * temp data dir for the filesystem classes (workspace, memory, sessions,
 * tasks.db, archive). No mocking of the purge logic itself — only `config.js`
 * is patched to point DATA_DIR/GROUPS_DIR at the temp dir, exactly like
 * `groups.test.ts`'s DATA_DIR override.
 *
 * The temp dir is created once (`beforeAll`) and removed once (`afterAll`,
 * best-effort) rather than per-test — every fixture-writing test below uses
 * its own uniquely-named agent/folder, so no cross-test cleanup is needed,
 * and this sidesteps a Windows-only same-process file-lock race on a
 * just-closed sqlite handle that a per-test rm hit in local verification.
 *
 * The load-bearing case throughout is the WRONG-USER GUARD: a control
 * principal / control agent's rows and files must survive every assertion.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// `vi.mock` factories are hoisted above top-level const declarations, so the
// paths are literal here (mirrors groups.test.ts's DATA_DIR override) — kept
// in sync with the TEST_* constants below by convention.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-erase-user/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-erase-user/groups',
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-erase-user';
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureSchema } from '../../db/session-db.js';
import type { CallerContext } from '../frame.js';
import { eraseUser, parseEraseUserArgs } from './erase-user.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT_CALLER: CallerContext = {
  caller: 'agent',
  agentGroupId: 'ag-evil',
  sessionId: 'sess-x',
  messagingGroupId: 'mg-x',
};

function now(): string {
  return new Date().toISOString();
}

function writeGroupFixture(folder: string, extraFiles: Record<string, string> = {}): void {
  const dir = path.join(TEST_GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), '# private notes\nsensitive stuff\n');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Creates DATA_DIR/v2-sessions/<agentGroupId>/<sessionId>/{inbound,outbound}.db with `rows` messages each. */
function writeSessionFixture(agentGroupId: string, sessionId: string, rows: number): void {
  const sessionDir = path.join(TEST_DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const inboundPath = path.join(sessionDir, 'inbound.db');
  ensureSchema(inboundPath, 'inbound');
  const inDb = new Database(inboundPath);
  for (let i = 0; i < rows; i++) {
    inDb
      .prepare(`INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', ?, '{}')`)
      .run(`min-${sessionId}-${i}`, i * 2 + 2, now());
  }
  inDb.close();

  const outboundPath = path.join(sessionDir, 'outbound.db');
  ensureSchema(outboundPath, 'outbound');
  const outDb = new Database(outboundPath);
  for (let i = 0; i < rows; i++) {
    outDb
      .prepare(`INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', ?, '{}')`)
      .run(`mout-${sessionId}-${i}`, i * 2 + 1, now());
  }
  outDb.close();
}

/** Reads a session db table count and closes the handle (avoids leaking a Windows file lock). */
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
      CREATE TABLE IF NOT EXISTS statuses (
        agent_group_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'idle',
        summary TEXT, blockers TEXT, eta TEXT, updated_at TEXT NOT NULL
      );
    `);
    return fn(db);
  } finally {
    db.close();
  }
}

describe('parseEraseUserArgs', () => {
  it('requires googleSub and principal', () => {
    expect(() => parseEraseUserArgs({ principal: 'google:1' })).toThrow(/googleSub/);
    expect(() => parseEraseUserArgs({ googleSub: '1' })).toThrow(/principal/);
  });

  it('defaults agentGroupId to null and booleans to false', () => {
    const args = parseEraseUserArgs({ googleSub: '1', principal: 'google:1' });
    expect(args).toEqual({
      googleSub: '1',
      principal: 'google:1',
      agentGroupId: null,
      beforeWindow: false,
      dryRun: false,
    });
  });

  it('accepts agentGroupId, beforeWindow, dryRun', () => {
    const args = parseEraseUserArgs({
      googleSub: '1',
      principal: 'google:1',
      agentGroupId: 'ag-1',
      beforeWindow: true,
      dryRun: true,
    });
    expect(args).toMatchObject({ agentGroupId: 'ag-1', beforeWindow: true, dryRun: true });
  });
});

describe('erase_user', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Best-effort — a lingering Windows file-lock on a temp dir isn't this suite's problem.
    }
  });

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('rejects a non-host caller and mutates nothing', async () => {
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('google:1', 'google', 'x', ?)`)
      .run(now());
    getDb()
      .prepare(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('google:1', 'admin', NULL, ?)`,
      )
      .run(now());

    const r = await eraseUser(
      { googleSub: '1', principal: 'google:1', agentGroupId: null, beforeWindow: false, dryRun: false },
      AGENT_CALLER,
    );
    expect(r).toMatchObject({ ok: false, error: 'not-host' });
    expect(getDb().prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'google:1'`).get()).toMatchObject({
      c: 1,
    });
  });

  it('deletes user_roles + agent_group_members for the principal GLOBALLY — the control principal survives', async () => {
    createAgentGroup({ id: 'ag-a', name: 'A', folder: 'guard-a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-b', name: 'B', folder: 'guard-b', agent_provider: null, created_at: now() });
    const db = getDb();
    for (const uid of ['google:victim', 'google:control']) {
      db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'google', ?, ?)`).run(
        uid,
        uid,
        now(),
      );
    }
    // Victim has rows in BOTH groups (not just their "own" one) — the global
    // DELETE (no agent_group_id filter) must catch both.
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('google:victim', 'admin', 'ag-a', ?)`,
    ).run(now());
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('google:victim', 'admin', 'ag-b', ?)`,
    ).run(now());
    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES ('google:victim', 'ag-a', ?)`,
    ).run(now());
    // Control principal, same shape, must NOT be touched.
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('google:control', 'admin', 'ag-a', ?)`,
    ).run(now());
    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES ('google:control', 'ag-a', ?)`,
    ).run(now());

    const r = await eraseUser(
      { googleSub: 'victim', principal: 'google:victim', agentGroupId: null, beforeWindow: false, dryRun: false },
      HOST,
    );

    expect(r).toMatchObject({ ok: true, purged: { userRoles: 2, agentGroupMembers: 1 } });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'google:victim'`).get()).toMatchObject({
      c: 0,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM agent_group_members WHERE user_id = 'google:victim'`).get(),
    ).toMatchObject({ c: 0 });
    // Control principal untouched.
    expect(db.prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'google:control'`).get()).toMatchObject({
      c: 1,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM agent_group_members WHERE user_id = 'google:control'`).get(),
    ).toMatchObject({ c: 1 });
  });

  it('dryRun counts only — DB rows and filesystem state are untouched', async () => {
    createAgentGroup({
      id: 'ag-dryrun',
      name: 'dryrun',
      folder: 'dryrun-victim',
      agent_provider: null,
      created_at: now(),
    });
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('google:dryrun', 'google', 'x', ?)`)
      .run(now());
    getDb()
      .prepare(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('google:dryrun', 'admin', NULL, ?)`,
      )
      .run(now());
    getDb()
      .prepare(
        `INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES ('google:dryrun', 'ag-dryrun', ?)`,
      )
      .run(now());

    writeGroupFixture('dryrun-victim');
    writeSessionFixture('ag-dryrun', 'sess-1', 2);
    withTasksDb((tdb) => {
      tdb
        .prepare(
          `INSERT INTO tasks (id, agent_group_id, title, created_at, updated_at) VALUES ('t-dryrun', 'ag-dryrun', 'x', ?, ?)`,
        )
        .run(now(), now());
    });

    const r = await eraseUser(
      {
        googleSub: 'dryrun',
        principal: 'google:dryrun',
        agentGroupId: 'ag-dryrun',
        beforeWindow: false,
        dryRun: true,
      },
      HOST,
    );

    expect(r).toMatchObject({
      ok: true,
      purged: { chat: 4, memory: 1, files: 1, tasks: 1, userRoles: 1, agentGroupMembers: 1 },
    });

    // Nothing actually mutated.
    expect(getDb().prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'google:dryrun'`).get()).toMatchObject(
      { c: 1 },
    );
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'dryrun-victim'))).toBe(true);
    expect(fs.readFileSync(path.join(TEST_GROUPS_DIR, 'dryrun-victim', 'CLAUDE.local.md'), 'utf-8')).toContain(
      'sensitive',
    );
    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-dryrun', 'sess-1', 'inbound.db'), 'messages_in'),
    ).toBe(2);
  });

  it('missing / never-provisioned agentGroupId (null) only purges the global role/membership rows', async () => {
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('google:ghost', 'google', 'x', ?)`)
      .run(now());
    getDb()
      .prepare(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('google:ghost', 'admin', NULL, ?)`,
      )
      .run(now());

    const r = await eraseUser(
      { googleSub: 'ghost', principal: 'google:ghost', agentGroupId: null, beforeWindow: false, dryRun: false },
      HOST,
    );
    expect(r).toMatchObject({
      ok: true,
      purged: { chat: 0, memory: 0, files: 0, tasks: 0, archive: 0, userRoles: 1, agentGroupMembers: 0 },
    });
  });

  it('a nonexistent agentGroupId is idempotent zeros, not an error', async () => {
    const r = await eraseUser(
      {
        googleSub: 'nobody',
        principal: 'google:nobody',
        agentGroupId: 'ag-does-not-exist',
        beforeWindow: false,
        dryRun: false,
      },
      HOST,
    );
    expect(r).toMatchObject({ ok: true, purged: { chat: 0, memory: 0, files: 0, tasks: 0 } });
  });

  it('purges chat/memory/files/tasks for the agent — a control agent (wrong-agent guard) survives', async () => {
    createAgentGroup({
      id: 'ag-victim',
      name: 'victim',
      folder: 'wipe-victim',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-control',
      name: 'control',
      folder: 'wipe-control',
      agent_provider: null,
      created_at: now(),
    });

    writeGroupFixture('wipe-victim', { 'notes/private.md': 'secret' });
    writeGroupFixture('wipe-control');
    writeSessionFixture('ag-victim', 'sess-1', 2);
    writeSessionFixture('ag-victim', 'sess-2', 1);
    writeSessionFixture('ag-control', 'sess-1', 3);

    withTasksDb((tdb) => {
      tdb
        .prepare(
          `INSERT INTO tasks (id, agent_group_id, title, created_at, updated_at) VALUES ('t-v', 'ag-victim', 'v', ?, ?)`,
        )
        .run(now(), now());
      tdb
        .prepare(
          `INSERT INTO tasks (id, agent_group_id, title, created_at, updated_at) VALUES ('t-c', 'ag-control', 'c', ?, ?)`,
        )
        .run(now(), now());
    });

    const r = await eraseUser(
      {
        googleSub: 'wipe-victim-sub',
        principal: 'google:wipe-victim-sub',
        agentGroupId: 'ag-victim',
        beforeWindow: false,
        dryRun: false,
      },
      HOST,
    );

    // sess-1 (2 in + 2 out) + sess-2 (1 in + 1 out) = 6.
    expect(r).toMatchObject({ ok: true, purged: { chat: 6, memory: 1, tasks: 1 } });
    if (r.ok) expect(r.purged.files).toBeGreaterThan(0);

    // Victim's workspace is gone entirely.
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'wipe-victim'))).toBe(false);
    withTasksDb((tdb) => {
      expect(tdb.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE agent_group_id = 'ag-victim'`).get()).toMatchObject({
        c: 0,
      });
      // Control agent's tasks survive.
      expect(tdb.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE agent_group_id = 'ag-control'`).get()).toMatchObject({
        c: 1,
      });
    });
    // Control agent's workspace + session content survive.
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'wipe-control', 'CLAUDE.local.md'))).toBe(true);
    expect(
      countTable(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-control', 'sess-1', 'inbound.db'), 'messages_in'),
    ).toBe(3);
  });

  it("removes an archive dir carrying the sub, and leaves a different sub's archive alone", async () => {
    const victimArchive = path.join(
      TEST_GROUPS_DIR,
      'archive-main',
      'archive',
      `old__archive-victim-sub__${Date.now()}`,
    );
    const otherArchive = path.join(TEST_GROUPS_DIR, 'archive-main', 'archive', `old__archive-other-sub__${Date.now()}`);
    fs.mkdirSync(victimArchive, { recursive: true });
    fs.writeFileSync(path.join(victimArchive, 'CLAUDE.local.md'), 'x');
    fs.mkdirSync(otherArchive, { recursive: true });
    fs.writeFileSync(path.join(otherArchive, 'CLAUDE.local.md'), 'x');

    const r = await eraseUser(
      {
        googleSub: 'archive-victim-sub',
        principal: 'google:archive-victim-sub',
        agentGroupId: null,
        beforeWindow: false,
        dryRun: false,
      },
      HOST,
    );

    expect(r).toMatchObject({ ok: true, purged: { archive: 1 } });
    expect(fs.existsSync(victimArchive)).toBe(false);
    expect(fs.existsSync(otherArchive)).toBe(true);
  });
});
