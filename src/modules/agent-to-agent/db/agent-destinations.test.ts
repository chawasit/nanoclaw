/**
 * DB-layer tests for `countChildren` — the direct-reports counter behind the
 * recruiting headcount cap (create-agent.ts, Path A slice 1).
 *
 * Real in-memory sqlite (not mocks) because the one fallible piece is the SQL:
 * children are identified by the hardcoded child→creator `parent` edge that
 * create_agent writes, and we must (a) count `parent` + `parent-<n>` collisions,
 * (b) exclude the creator's OWN inbound edge from its grandparent, and (c) NOT
 * match a look-alike name like `parental`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../../db/index.js';
import { createDestination, countChildren } from './agent-destinations.js';

function group(id: string) {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-01-01T00:00:00Z' });
}
function edge(from: string, localName: string, to: string) {
  createDestination({
    agent_group_id: from,
    local_name: localName,
    target_type: 'agent',
    target_id: to,
    created_at: '2026-01-01T00:00:00Z',
  });
}

beforeEach(() => {
  runMigrations(initTestDb());
});
afterEach(() => {
  closeDb();
});

describe('countChildren', () => {
  it('counts only the direct reports (child→creator `parent` edges), including `parent-<n>` collisions', () => {
    // gp creates p; p creates c1, c2, and c3 (whose `parent` name collided → `parent-2`).
    ['gp', 'p', 'c1', 'c2', 'c3'].forEach(group);
    edge('gp', 'p', 'p');
    edge('p', 'parent', 'gp'); // p's OWN parent edge (points at gp, not p)
    edge('p', 'c1', 'c1');
    edge('c1', 'parent', 'p');
    edge('p', 'c2', 'c2');
    edge('c2', 'parent', 'p');
    edge('p', 'c3', 'c3');
    edge('c3', 'parent-2', 'p'); // collision-suffixed parent edge

    expect(countChildren('p')).toBe(3);
    expect(countChildren('gp')).toBe(1); // just p
  });

  it('does not match a look-alike local_name like `parental`', () => {
    ['p', 'x'].forEach(group);
    edge('x', 'parental', 'p'); // points at p but is NOT a parent edge
    expect(countChildren('p')).toBe(0);
  });

  it('returns 0 for an agent with no reports', () => {
    group('lonely');
    expect(countChildren('lonely')).toBe(0);
  });
});
