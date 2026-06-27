/**
 * Unit tests for `ncl provision` (Circle M03) — the pure policy branches and the
 * happy-path orchestration, with every spine collaborator mocked. The full
 * create→wire→mint round-trip is covered on the TEST SPINE (never prod) per
 * SPEC-M03 §8/§9; here we pin the host-only gate, the fail-closed config/domain
 * gates, the one-human-one-agent idempotency, and the call sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallerContext } from '../frame.js';

const mockGet = vi.fn();
const mockGetAgentGroup = vi.fn();
const mockFindSession = vi.fn();
const mockGetContainerConfig = vi.fn();
const mockUpdateScalars = vi.fn();
const mockUpdateJson = vi.fn();
const mockCreateMg = vi.fn();
const mockCreateMga = vi.fn();
const mockCreateDestination = vi.fn();
const mockPerformCreateAgent = vi.fn();
const mockUpsertUser = vi.fn();
const mockRouteInbound = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: (...a: unknown[]) => mockGet(...a) }) }),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('../../db/sessions.js', () => ({ findSessionByAgentGroup: (...a: unknown[]) => mockFindSession(...a) }));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateScalars(...a),
  updateContainerConfigJson: (...a: unknown[]) => mockUpdateJson(...a),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  createMessagingGroup: (...a: unknown[]) => mockCreateMg(...a),
  createMessagingGroupAgent: (...a: unknown[]) => mockCreateMga(...a),
}));
vi.mock('../../modules/agent-to-agent/db/agent-destinations.js', () => ({
  createDestination: (...a: unknown[]) => mockCreateDestination(...a),
}));
vi.mock('../../modules/agent-to-agent/create-agent.js', () => ({
  performCreateAgent: (...a: unknown[]) => mockPerformCreateAgent(...a),
}));
vi.mock('../../modules/permissions/db/users.js', () => ({ upsertUser: (...a: unknown[]) => mockUpsertUser(...a) }));
vi.mock('../../router.js', () => ({ routeInbound: (...a: unknown[]) => mockRouteInbound(...a) }));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { provision } from './provision.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT = { caller: 'agent', agentGroupId: 'ag-evil', sessionId: 'sess-x' } as unknown as CallerContext;
const ARGS = { googleSub: '1234567890', email: 'alice@trirat.co', domain: 'trirat.co' };

function setGoodConfig() {
  process.env.PROVISION_ALLOWED_DOMAINS = 'trirat.co';
  process.env.PROVISION_MAIN_AGENT_ID = 'ag-cos';
  process.env.PROVISION_MODEL = 'gemma-4-26B-A4B';
  process.env.PROVISION_BASE_URL = 'http://10.0.0.9:11434';
  process.env.PROVISION_API_KEY = 'ollama';
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockReturnValue(undefined); // no existing binding by default
  mockGetAgentGroup.mockReturnValue({ id: 'ag-cos', name: 'CoS', folder: 'cos', agent_provider: null, created_at: '' });
  mockFindSession.mockReturnValue({ id: 'sess-cos', agent_group_id: 'ag-cos' });
  mockGetContainerConfig.mockReturnValue({ env: '{}', blocked_hosts: '[]' });
  mockPerformCreateAgent.mockResolvedValue({
    id: 'ag-new',
    name: 'alice',
    folder: 'alice',
    agent_provider: null,
    created_at: '',
  });
});

afterEach(() => {
  delete process.env.PROVISION_ALLOWED_DOMAINS;
  delete process.env.PROVISION_MAIN_AGENT_ID;
  delete process.env.PROVISION_MODEL;
  delete process.env.PROVISION_BASE_URL;
  delete process.env.PROVISION_API_KEY;
});

describe('provision — fail-closed gates', () => {
  it('rejects a non-host caller (host-only control plane)', async () => {
    setGoodConfig();
    const r = await provision(ARGS, AGENT);
    expect(r.ok).toBe(false);
    expect(r.refusals).toEqual(['not-host']);
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });

  it('refuses when host config is incomplete (no silent cloud-spend / misparent)', async () => {
    // Only the domain set — model/base-url/main-agent missing → misconfigured.
    process.env.PROVISION_ALLOWED_DOMAINS = 'trirat.co';
    const r = await provision(ARGS, HOST);
    expect(r.ok).toBe(false);
    expect(r.refusals).toEqual(['misconfigured']);
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });

  it('refuses an out-of-domain identity (the positive creation gate)', async () => {
    setGoodConfig();
    const r = await provision({ ...ARGS, domain: 'evil.com' }, HOST);
    expect(r.ok).toBe(false);
    expect(r.refusals).toEqual(['domain-not-allowed']);
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });
});

describe('provision — idempotency (one human, one agent)', () => {
  it('short-circuits to the existing agent, never creating a second', async () => {
    setGoodConfig();
    mockGet.mockReturnValue({ agent_group_id: 'ag-existing' });
    const r = await provision(ARGS, HOST);
    expect(r).toMatchObject({ ok: true, created: false, agentGroupId: 'ag-existing' });
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });
});

describe('provision — happy path orchestration', () => {
  it('ensures the users row, creates under the main agent with the principal, wires the lane, mints the session', async () => {
    setGoodConfig();
    const r = await provision(ARGS, HOST);

    expect(r).toMatchObject({ ok: true, created: true, agentGroupId: 'ag-new' });

    // FK prerequisite: the users row precedes the binding.
    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'google:1234567890', kind: 'google', display_name: 'alice@trirat.co' }),
    );
    // Created under the main agent, with the principal binding threaded in.
    const [, , session, sourceGroup, , opts] = mockPerformCreateAgent.mock.calls[0];
    expect(session).toMatchObject({ agent_group_id: 'ag-cos' });
    expect(sourceGroup).toMatchObject({ id: 'ag-cos' });
    expect(opts).toMatchObject({ principalUserId: 'google:1234567890', domain: 'trirat.co' });

    // $0 model + endpoint applied to the NEW agent.
    expect(mockUpdateScalars).toHaveBeenCalledWith('ag-new', { model: 'gemma-4-26B-A4B' });

    // The reply-routing destination is named exactly `local-cli`.
    expect(mockCreateDestination).toHaveBeenCalledWith(
      expect.objectContaining({ agent_group_id: 'ag-new', local_name: 'local-cli', target_type: 'channel' }),
    );
    // Lane mg on the unique web platform id, instance=cli.
    expect(mockCreateMg).toHaveBeenCalledWith(
      expect.objectContaining({ channel_type: 'cli', platform_id: 'web:google:1234567890', instance: 'cli' }),
    );
    expect(mockCreateMga).toHaveBeenCalledTimes(1);
    // Session minted by routing a bootstrap at the lane.
    expect(mockRouteInbound).toHaveBeenCalledTimes(1);
    const event = mockRouteInbound.mock.calls[0][0];
    expect(event).toMatchObject({ channelType: 'cli', platformId: 'web:google:1234567890' });
  });

  it('refuses when the main agent has no active session (create projection needs one)', async () => {
    setGoodConfig();
    mockFindSession.mockReturnValue(undefined);
    const r = await provision(ARGS, HOST);
    expect(r.ok).toBe(false);
    expect(r.refusals).toEqual(['no-main-agent-session']);
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });
});
