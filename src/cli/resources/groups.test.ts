/**
 * Regression test for #2525 — `ncl groups delete` must cascade dependent
 * rows in FK order so the final `DELETE FROM agent_groups` succeeds even
 * when the group has sessions, destinations, approvals, role grants, etc.
 *
 * The bug pre-fix: the generic single-table DELETE handler ran a bare
 * `DELETE FROM agent_groups WHERE id = ?` which always failed with a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when anything pointed at the group.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch
 * with the host caller — same code path a real approval would take.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups' };
});

// The `access: 'approval'` branch in dispatch.ts calls requestApproval() for
// non-host callers — stub it so the host-only-guard test doesn't touch real
// delivery/notification plumbing.
vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(undefined),
}));

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getDb();

    // Direct inserts for the dependent tables. Keeps the fixture minimal —
    // we only need rows that establish FK relationships, not full domain
    // entities.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
    ).run(GID, MGID, now());

    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
    ).run('q-1', SID, now());

    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run('pa-1', SID, now(), GID);

    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    ).run(MGID, GID, now());

    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run(UID, GID, now());

    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    ).run(UID, GID, now());

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());

    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { deleted: string; removed: Record<string, number> } }).data;
    expect(data.deleted).toBe(GID);
    expect(data.removed).toMatchObject({
      sessions: 1,
      pending_questions: 1,
      pending_approvals: 1,
      agent_destinations_owned: 1,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
      messaging_group_agents: 1,
      agent_group_members: 1,
      user_roles: 1,
      container_configs: 1,
    });

    // The group and every dependent row must be gone.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);

    // Unrelated tables untouched.
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('cascades agent_message_policies (both directions) alongside channel/sender approvals + questions', async () => {
    // Regression for the latent prod bug (SWEEP-3 §S2): the cascade missed
    // agent_message_policies (migration 017), whose from_/to_agent_group_id BOTH
    // FK-reference agent_groups(id). With foreign_keys=ON, the first decommission
    // of any agent that ever had a message policy OR a channel/sender approval
    // throws SQLITE_CONSTRAINT_FOREIGNKEY and aborts the whole transaction. Two
    // groups + two policy rows (victim→other AND other→victim) exercise both
    // WHERE legs — a self-edge would not prove "both directions".
    const VICTIM = 'ag-policy-victim';
    const OTHER = 'ag-policy-other';
    const SID = 'sess-policy-1';
    const MGID = 'mg-policy';
    const UID = 'tg:77';

    createAgentGroup({ id: VICTIM, name: 'victim', folder: 'pv', agent_provider: null, created_at: now() });
    createAgentGroup({ id: OTHER, name: 'other', folder: 'po', agent_provider: null, created_at: now() });
    createSession({
      id: SID,
      agent_group_id: VICTIM,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getDb();
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-p', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    // The four FK row-classes the team-lead named: channel approval, sender
    // approval, a pending question, and a message policy (both directions).
    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, VICTIM, UID, now());
    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-p', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, VICTIM, UID, now());
    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-p', 'q', '[]', ?)`,
    ).run('q-p', SID, now());
    db.prepare(
      `INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approver, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(VICTIM, OTHER, UID, now());
    db.prepare(
      `INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approver, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(OTHER, VICTIM, UID, now());

    const resp = await dispatch(
      { id: 'req-del-p', command: 'groups-delete', args: { id: VICTIM } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_message_policies).toBe(2);

    // Victim gone; OTHER survives; every policy row referencing victim is gone.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', VICTIM)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', OTHER)).toBe(1);
    expect(
      count(
        'SELECT COUNT(*) AS c FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?',
        VICTIM,
        VICTIM,
      ),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', VICTIM)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', VICTIM)).toBe(0);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
    ).run(B, A, now());

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-missing', command: 'groups-delete', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });
});

/**
 * `ncl groups config update-env` — M16 seam: a sibling service (Circle) patches
 * an agent's container_configs.env over ncl.sock (e.g. to inject its own
 * LiteLLM virtual key) without clobbering existing env keys. Gated exactly
 * like the other config-mutation verbs (`access: 'approval'` — inline for the
 * host caller, approval-pending for an agent caller).
 */
describe('groups-config-update-env (#M16)', () => {
  const GID = 'ag-env-test';

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: GID, name: 'env-test', folder: 'env-test', agent_provider: null, created_at: now() });
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, env, blocked_hosts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', ?, '[]', 'group', ?)`,
    ).run(GID, JSON.stringify({ EXISTING_KEY: 'keep-me', ANTHROPIC_API_KEY: 'old-key' }), now());
  });

  function envOf(id: string): Record<string, string> {
    const row = getDb().prepare('SELECT env FROM container_configs WHERE agent_group_id = ?').get(id) as {
      env: string;
    };
    return JSON.parse(row.env);
  }

  function blockedHostsOf(id: string): string[] {
    const row = getDb().prepare('SELECT blocked_hosts FROM container_configs WHERE agent_group_id = ?').get(id) as {
      blocked_hosts: string;
    };
    return JSON.parse(row.blocked_hosts);
  }

  it('merges the patch into existing env — untouched keys survive, overridden keys change', async () => {
    const resp = await dispatch(
      {
        id: 'req-env-1',
        command: 'groups-config-update-env',
        args: { id: GID, env: { ANTHROPIC_API_KEY: 'new-key', LITELLM_VIRTUAL_KEY: 'sk-abc' } },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(envOf(GID)).toEqual({
      EXISTING_KEY: 'keep-me',
      ANTHROPIC_API_KEY: 'new-key',
      LITELLM_VIRTUAL_KEY: 'sk-abc',
    });
  });

  it('sets blocked_hosts when blockedHosts is provided (and leaves it untouched when omitted)', async () => {
    const resp = await dispatch(
      {
        id: 'req-env-2',
        command: 'groups-config-update-env',
        args: { id: GID, env: { FOO: 'bar' }, blockedHosts: ['api.anthropic.com', 'evil.example'] },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect(blockedHostsOf(GID)).toEqual(['api.anthropic.com', 'evil.example']);

    const resp2 = await dispatch(
      { id: 'req-env-2b', command: 'groups-config-update-env', args: { id: GID, env: { FOO: 'baz' } } },
      { caller: 'host' },
    );
    expect(resp2.ok).toBe(true);
    // No blockedHosts passed this time — must stay whatever it was, not be cleared.
    expect(blockedHostsOf(GID)).toEqual(['api.anthropic.com', 'evil.example']);
  });

  it('rejects a missing --id', async () => {
    const resp = await dispatch(
      { id: 'req-env-3', command: 'groups-config-update-env', args: { env: { FOO: 'bar' } } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/id.*required/i);
  });

  it('rejects missing or empty --env', async () => {
    const respMissing = await dispatch(
      { id: 'req-env-4', command: 'groups-config-update-env', args: { id: GID } },
      { caller: 'host' },
    );
    expect(respMissing.ok).toBe(false);
    if (!respMissing.ok) expect(respMissing.error.message).toMatch(/env.*required/i);

    const respEmpty = await dispatch(
      { id: 'req-env-4b', command: 'groups-config-update-env', args: { id: GID, env: {} } },
      { caller: 'host' },
    );
    expect(respEmpty.ok).toBe(false);
  });

  it('is host-only: an agent caller gets approval-pending, and the env is NOT mutated inline', async () => {
    const SID = 'sess-env-guard';
    createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const resp = await dispatch(
      {
        id: 'req-env-5',
        command: 'groups-config-update-env',
        args: { id: GID, env: { SHOULD_NOT_APPLY: 'x' } },
      },
      { caller: 'agent', sessionId: SID, agentGroupId: GID, messagingGroupId: 'mg-x' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(envOf(GID)).not.toHaveProperty('SHOULD_NOT_APPLY');
  });
});
