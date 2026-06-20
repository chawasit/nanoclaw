import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted holder so the vi.mock factory can hand back the per-test in-memory DB.
const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db.js')>();
  return { ...actual, getTasklistDb: () => h.db };
});
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { applySchema } from './db.js';
import { handleReportStatus, handleTaskCreate, handleTaskUpdate } from './actions.js';

const session = (id: string) => ({ agent_group_id: id }) as never;
const NOOP_DB = {} as never;

beforeEach(() => {
  h.db = new Database(':memory:');
  applySchema(h.db);
});
afterEach(() => h.db.close());

const task = (id: string) => h.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
const stat = (ag: string) =>
  h.db.prepare('SELECT * FROM statuses WHERE agent_group_id = ?').get(ag) as Record<string, unknown>;

describe('handleTaskCreate', () => {
  it('inserts a task owned by the SESSION agent, ignoring agent-supplied owner', async () => {
    await handleTaskCreate({ taskId: 't1', title: 'Do the thing', agentGroupId: 'ag-EVIL' }, session('ag-1'), NOOP_DB);
    const row = task('t1');
    expect(row.title).toBe('Do the thing');
    expect(row.agent_group_id).toBe('ag-1'); // trusted session identity wins
  });

  it('no-ops when title is missing', async () => {
    await handleTaskCreate({ taskId: 't2' }, session('ag-1'), NOOP_DB);
    expect(task('t2')).toBeUndefined();
  });

  it('no-ops when id is missing', async () => {
    await handleTaskCreate({ title: 'x' }, session('ag-1'), NOOP_DB);
    expect(h.db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 });
  });

  it('swallows duplicate-id errors without throwing (first write stands)', async () => {
    await handleTaskCreate({ taskId: 't3', title: 'A' }, session('ag-1'), NOOP_DB);
    await expect(handleTaskCreate({ taskId: 't3', title: 'B' }, session('ag-1'), NOOP_DB)).resolves.toBeUndefined();
    expect(task('t3').title).toBe('A');
  });
});

describe('handleTaskUpdate', () => {
  beforeEach(async () => {
    await handleTaskCreate({ taskId: 't1', title: 'T' }, session('ag-1'), NOOP_DB);
  });

  it('updates status for the owning agent', async () => {
    await handleTaskUpdate({ taskId: 't1', status: 'doing' }, session('ag-1'), NOOP_DB);
    expect(task('t1').status).toBe('doing');
  });

  it("does NOT update another agent's task (owner-scoped)", async () => {
    await handleTaskUpdate({ taskId: 't1', status: 'done' }, session('ag-2'), NOOP_DB);
    expect(task('t1').status).toBe('todo');
  });

  it('sets blocked_reason alongside status', async () => {
    await handleTaskUpdate(
      { taskId: 't1', status: 'blocked', blockedReason: 'waiting on X' },
      session('ag-1'),
      NOOP_DB,
    );
    const row = task('t1');
    expect(row.status).toBe('blocked');
    expect(row.blocked_reason).toBe('waiting on X');
  });

  it('swallows invalid-status errors', async () => {
    await expect(
      handleTaskUpdate({ taskId: 't1', status: 'bogus' }, session('ag-1'), NOOP_DB),
    ).resolves.toBeUndefined();
    expect(task('t1').status).toBe('todo');
  });

  it('no-ops when id is missing', async () => {
    await expect(handleTaskUpdate({ status: 'doing' }, session('ag-1'), NOOP_DB)).resolves.toBeUndefined();
  });
});

describe('handleReportStatus', () => {
  it('upserts the latest-per-agent status', async () => {
    await handleReportStatus({ state: 'working', summary: 's1' }, session('ag-1'), NOOP_DB);
    await handleReportStatus({ state: 'blocked', summary: 's2', blockers: 'b', eta: '1h' }, session('ag-1'), NOOP_DB);
    const row = stat('ag-1');
    expect(row.state).toBe('blocked'); // latest wins
    expect(row.summary).toBe('s2');
    expect(row.blockers).toBe('b');
    expect(row.eta).toBe('1h');
  });

  it('attributes the status to the session agent', async () => {
    await handleReportStatus({ state: 'idle', agentGroupId: 'ag-EVIL' }, session('ag-7'), NOOP_DB);
    expect(stat('ag-7').state).toBe('idle');
    expect(stat('ag-EVIL')).toBeUndefined();
  });

  it('no-ops when state is missing', async () => {
    await handleReportStatus({ summary: 'x' }, session('ag-1'), NOOP_DB);
    expect(stat('ag-1')).toBeUndefined();
  });

  it('swallows invalid-state errors', async () => {
    await expect(handleReportStatus({ state: 'bogus' }, session('ag-1'), NOOP_DB)).resolves.toBeUndefined();
    expect(stat('ag-1')).toBeUndefined();
  });
});
