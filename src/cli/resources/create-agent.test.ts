/**
 * Unit tests for the `create_agent` host-only CLI command (Circle M12) — every
 * spine collaborator mocked, mirroring provision.test.ts. Pins the host-only
 * gate, arg validation, parent-not-found, the no-active-session refusal, the
 * happy path's performCreateAgent call + return shape, and the model setter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallerContext } from '../frame.js';

const mockGetAgentGroup = vi.fn();
const mockFindSession = vi.fn();
const mockPerformCreateAgent = vi.fn();
const mockUpdateScalars = vi.fn();

vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('../../db/sessions.js', () => ({ findSessionByAgentGroup: (...a: unknown[]) => mockFindSession(...a) }));
vi.mock('../../db/container-configs.js', () => ({
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateScalars(...a),
}));
vi.mock('../../modules/agent-to-agent/create-agent.js', () => ({
  performCreateAgent: (...a: unknown[]) => mockPerformCreateAgent(...a),
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createAgent, parseCreateAgentArgs } from './create-agent.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT = { caller: 'agent', agentGroupId: 'ag-evil', sessionId: 'sess-x' } as unknown as CallerContext;
const PARENT = { id: 'ag-parent', name: 'Parent', folder: 'parent', agent_provider: null, created_at: '' };
const PARENT_SESSION = { id: 'sess-parent', agent_group_id: 'ag-parent' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentGroup.mockReturnValue(PARENT);
  mockFindSession.mockReturnValue(PARENT_SESSION);
  mockPerformCreateAgent.mockResolvedValue({
    id: 'ag-new',
    name: 'alice',
    folder: 'alice',
    agent_provider: null,
    created_at: '',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCreateAgentArgs', () => {
  it('requires parentAgentGroupId and name', () => {
    expect(() => parseCreateAgentArgs({ name: 'alice' })).toThrow(/parentAgentGroupId/);
    expect(() => parseCreateAgentArgs({ parentAgentGroupId: 'ag-parent' })).toThrow(/name/);
  });

  it('accepts optional roleBrief and model', () => {
    const args = parseCreateAgentArgs({
      parentAgentGroupId: 'ag-parent',
      name: 'alice',
      roleBrief: { reportsTo: 'CoS', mandate: 'do stuff', doneWhen: 'done' },
      model: 'gemma-4-26B-A4B',
    });
    expect(args).toMatchObject({ parentAgentGroupId: 'ag-parent', name: 'alice', model: 'gemma-4-26B-A4B' });
    expect(args.roleBrief).toMatchObject({ reportsTo: 'CoS' });
  });

  it('rejects an invalid roleBrief', () => {
    expect(() =>
      parseCreateAgentArgs({ parentAgentGroupId: 'ag-parent', name: 'alice', roleBrief: { mandate: 'x' } }),
    ).toThrow(/reportsTo|doneWhen/);
  });

  it('accepts a free-text (string) roleBrief — the Circle admin-form shape', () => {
    const args = parseCreateAgentArgs({
      parentAgentGroupId: 'ag-parent',
      name: 'alice',
      roleBrief: '  You handle research digests.  ',
    });
    expect(args.roleBrief).toBe('You handle research digests.');
  });

  it('drops a blank string roleBrief instead of storing empty instructions', () => {
    const args = parseCreateAgentArgs({ parentAgentGroupId: 'ag-parent', name: 'alice', roleBrief: '   ' });
    expect(args.roleBrief).toBeUndefined();
  });
});

describe('create_agent — host-only gate', () => {
  it('rejects a non-host caller', async () => {
    const r = await createAgent({ parentAgentGroupId: 'ag-parent', name: 'alice' }, AGENT);
    expect(r).toMatchObject({ ok: false, error: 'not-host' });
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });
});

describe('create_agent — parent resolution', () => {
  it('fails closed when the parent agent group does not exist', async () => {
    mockGetAgentGroup.mockReturnValue(undefined);
    const r = await createAgent({ parentAgentGroupId: 'ag-ghost', name: 'alice' }, HOST);
    expect(r).toMatchObject({ ok: false, error: 'parent_not_found' });
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });

  it('fails closed (does not throw) when the parent has no active session', async () => {
    mockFindSession.mockReturnValue(undefined);
    const r = await createAgent({ parentAgentGroupId: 'ag-parent', name: 'alice' }, HOST);
    expect(r).toMatchObject({ ok: false, error: 'parent_not_active' });
    expect(mockPerformCreateAgent).not.toHaveBeenCalled();
  });
});

describe('create_agent — happy path', () => {
  it('creates under the resolved parent and returns the new id', async () => {
    const r = await createAgent({ parentAgentGroupId: 'ag-parent', name: 'alice' }, HOST);
    expect(r).toMatchObject({ ok: true, agentGroupId: 'ag-new' });

    const [name, instructions, session, sourceGroup] = mockPerformCreateAgent.mock.calls[0];
    expect(name).toBe('alice');
    expect(instructions).toBeNull();
    expect(session).toMatchObject({ agent_group_id: 'ag-parent' });
    expect(sourceGroup).toMatchObject({ id: 'ag-parent' });
    expect(mockUpdateScalars).not.toHaveBeenCalled();
  });

  it('renders a valid roleBrief into instructions', async () => {
    await createAgent(
      {
        parentAgentGroupId: 'ag-parent',
        name: 'alice',
        roleBrief: { reportsTo: 'CoS', mandate: 'do stuff', doneWhen: 'done' },
      },
      HOST,
    );
    const instructions = mockPerformCreateAgent.mock.calls[0][1] as string;
    expect(instructions).toContain('Role brief');
    expect(instructions).toContain('do stuff');
  });

  it('passes a free-text roleBrief through verbatim as instructions', async () => {
    await createAgent(
      { parentAgentGroupId: 'ag-parent', name: 'alice', roleBrief: 'You handle research digests.' },
      HOST,
    );
    expect(mockPerformCreateAgent.mock.calls[0][1]).toBe('You handle research digests.');
  });

  it('sets the model on the new group when given', async () => {
    const r = await createAgent({ parentAgentGroupId: 'ag-parent', name: 'alice', model: 'gemma-4-26B-A4B' }, HOST);
    expect(r).toMatchObject({ ok: true, agentGroupId: 'ag-new' });
    expect(mockUpdateScalars).toHaveBeenCalledWith('ag-new', { model: 'gemma-4-26B-A4B' });
  });

  it('fails closed when performCreateAgent declines (returns null)', async () => {
    mockPerformCreateAgent.mockResolvedValue(null);
    const r = await createAgent({ parentAgentGroupId: 'ag-parent', name: 'alice' }, HOST);
    expect(r).toMatchObject({ ok: false, error: 'create_failed' });
  });
});
