/**
 * Tests for task_list output formatting — specifically the bound on the
 * scope="all" dump. Without a limit the tool dumps every agent's every task
 * plus the whole status board (a list_all anti-pattern). formatTaskBoard caps
 * the rows and appends a truncation footer steering the agent to filter.
 */
import { describe, it, expect } from 'bun:test';

import { formatTaskBoard, type TaskRow, type StatusRow } from './tasklist.js';

function tasks(n: number): TaskRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tsk-${i}`,
    agent_group_id: `ag-${i}`,
    title: `task ${i}`,
    status: 'todo',
    blocked_reason: null,
  }));
}

function statuses(n: number): StatusRow[] {
  return Array.from({ length: n }, (_, i) => ({
    agent_group_id: `ag-${i}`,
    state: 'working',
    summary: `doing ${i}`,
    blockers: null,
    eta: null,
    updated_at: '2026-01-01',
  }));
}

describe('formatTaskBoard — limit + truncation footer (scope="all")', () => {
  it('shows all rows and no footer when under the limit', () => {
    const out = formatTaskBoard(tasks(3), statuses(2), 'all', 50);
    expect(out).toContain('task 0');
    expect(out).toContain('task 2');
    expect(out).not.toContain('more task');
  });

  it('clips tasks to the limit and appends a footer with the remaining count', () => {
    const out = formatTaskBoard(tasks(60), [], 'all', 50);
    expect(out).toContain('task 49'); // last shown
    expect(out).not.toContain('- ag-50 tsk-50'); // 51st row not shown
    expect(out).toContain('10 more task'); // 60 - 50
    expect(out).toContain('scope="mine"'); // steers the agent to narrow
  });

  it('clips the status board too and notes the remainder', () => {
    const out = formatTaskBoard(tasks(1), statuses(60), 'all', 50);
    expect(out).toContain('## Status board');
    expect(out).toContain('10 more status');
  });

  it('singularizes the footer count (1 more task)', () => {
    const out = formatTaskBoard(tasks(51), [], 'all', 50);
    expect(out).toContain('1 more task —');
    expect(out).not.toContain('1 more tasks');
  });

  it('scope="mine" omits the status board and the scope hint', () => {
    const out = formatTaskBoard(tasks(60), [], 'mine', 50);
    expect(out).not.toContain('## Status board');
    expect(out).toContain('10 more task');
    expect(out).not.toContain('scope="mine"');
  });
});
