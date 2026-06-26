/**
 * Tests for create_agent host-side authorization.
 *
 * Regression guard for the audit finding: `create_agent` is a privileged
 * central-DB write with no host-side authz. The fix authorizes by CLI scope —
 * trusted owner agent groups ('global') create directly; confined groups
 * ('group', the default and the prompt-injection victim) must get admin
 * approval. These tests pin that branch decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

// Mocks for the collaborators the branch decides between / depends on.
const mockRequestApproval = vi.fn().mockResolvedValue(undefined);
const mockGetContainerConfig = vi.fn();
const mockCreateAgentGroup = vi.fn();
const mockInitGroupFilesystem = vi.fn();
const mockApplyBaseProfile = vi.fn();
const mockSeedPersonality = vi.fn();
const mockSeedOnboarding = vi.fn();
const mockUpdateScalars = vi.fn();
const mockWriteDestinations = vi.fn();
const mockNotifyWrite = vi.fn();
const mockGetAllAgentGroups = vi.fn();
const mockCountChildren = vi.fn();
const mockAddMember = vi.fn();

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateScalars(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
  getAllAgentGroups: (...a: unknown[]) => mockGetAllAgentGroups(...a),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('../../base-profile.js', () => ({
  applyBaseProfile: (...a: unknown[]) => mockApplyBaseProfile(...a),
}));
vi.mock('../../personality.js', () => ({
  seedPersonality: (...a: unknown[]) => mockSeedPersonality(...a),
}));
vi.mock('../../onboarding.js', () => ({
  seedOnboarding: (...a: unknown[]) => mockSeedOnboarding(...a),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: vi.fn(),
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  countChildren: (...a: unknown[]) => mockCountChildren(...a),
}));
vi.mock('../permissions/db/agent-group-members.js', () => ({
  addMember: (...a: unknown[]) => mockAddMember(...a),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
}));

import { handleCreateAgent, applyCreateAgent, performCreateAgent } from './create-agent.js';
import type { AgentGroup } from '../../types.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const SOURCE_GROUP = { id: 'ag-1', name: 'AG-1', folder: 'ag-1', agent_provider: null, created_at: '' } as AgentGroup;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: well under both caps so existing scenarios proceed unchanged.
  mockGetAllAgentGroups.mockReturnValue([]);
  mockCountChildren.mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCreateAgent — scope-based authorization', () => {
  it('global scope: creates directly, no approval requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
  });

  it('renders a valid roleBrief into the child instructions, above the original', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    await handleCreateAgent(
      {
        name: 'Scout',
        instructions: 'help',
        roleBrief: { reportsTo: 'MD', mandate: 'scout the web', doneWhen: 'report filed' },
      },
      SESSION,
    );
    const opts = mockInitGroupFilesystem.mock.calls[0][1] as { instructions: string };
    expect(opts.instructions).toContain('<!-- role-brief -->');
    expect(opts.instructions).toContain('scout the web');
    expect(opts.instructions).toContain('help');
    expect(opts.instructions.indexOf('role-brief')).toBeLessThan(opts.instructions.indexOf('help'));
  });

  it('rejects an invalid roleBrief without creating the agent', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    await handleCreateAgent({ name: 'Scout', roleBrief: { reportsTo: 'MD' } }, SESSION);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('carries the rendered brief through the approval payload (group scope)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    await handleCreateAgent({ name: 'Scout', roleBrief: { reportsTo: 'MD', mandate: 'm', doneWhen: 'd' } }, SESSION);
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(
      (mockRequestApproval.mock.calls[0][0] as { payload: { instructions: string } }).payload.instructions,
    ).toContain('<!-- role-brief -->');
  });

  it('child inherits the creator provider (codex parent → codex child)', async () => {
    // A subagent must run on the same authenticated runtime as its creator —
    // on a codex-only install a claude default would 401. Red-on-delete:
    // dropping the inheritance leaves the child provider-less (→ claude).
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'codex' }),
    );
    expect(mockUpdateScalars).toHaveBeenCalledWith(expect.any(String), { provider: 'codex' });
  });

  it('claude creator leaves the child provider unset (built-in default)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' }); // no provider

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockUpdateScalars).not.toHaveBeenCalled();
  });

  it('group scope (default): requires approval, does NOT create directly', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({ action: 'create_agent' });
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('missing config: fails closed to approval (no direct create)', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('disabled/other scope: requires approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('empty name: neither creates nor requests approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: '' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('handleCreateAgent — org-size caps REMOVED (M08 cap-removal half)', () => {
  afterEach(() => {
    delete process.env.NANOCLAW_MAX_AGENTS;
    delete process.env.NANOCLAW_MAX_DIRECT_REPORTS;
  });

  it('default (env unset): a normal hire proceeds', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('caps are inert (M08 AC#1): creating past the old 25-agent / 10-report limits still proceeds', async () => {
    // The org-size/fan-out brakes no longer enforce — even with the old env vars
    // set tiny AND the (now-unread) counters far over the retired thresholds, the
    // create runs. Under the flat topology these caps were a hard company ceiling
    // M03 auto-provision would hit at the 11th hire.
    process.env.NANOCLAW_MAX_AGENTS = '1';
    process.env.NANOCLAW_MAX_DIRECT_REPORTS = '1';
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockGetAllAgentGroups.mockReturnValue(new Array(100).fill({})); // >> old 25
    mockCountChildren.mockReturnValue(50); // >> old 10
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it('confined (group) scope over the old cap: now reaches approval (no early cap short-circuit)', async () => {
    // The early cap denial is gone — a confined create over the retired limit now
    // takes the normal approval path instead of being denied up front.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetAllAgentGroups.mockReturnValue(new Array(100).fill({}));
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('performCreateAgent — returns the new id + Circle provisioning options (S1)', () => {
  it('returns the created AgentGroup with a real minted id', async () => {
    const notify = vi.fn();
    const created = await performCreateAgent('Scout', 'help', SESSION, SOURCE_GROUP, notify);

    expect(created).not.toBeNull();
    expect(created!.id).toMatch(/^ag-/);
    expect(created!.name).toBe('Scout');
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    // No principal supplied → the binding stays dormant.
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it('binds the supplied principal to the new agent group and threads the id back', async () => {
    const notify = vi.fn();
    const created = await performCreateAgent('Scout', 'help', SESSION, SOURCE_GROUP, notify, {
      principalUserId: 'google:sub-123',
      domain: 'example.com',
    });

    expect(created).not.toBeNull();
    expect(mockAddMember).toHaveBeenCalledTimes(1);
    expect(mockAddMember.mock.calls[0][0]).toMatchObject({
      user_id: 'google:sub-123',
      agent_group_id: created!.id,
      added_by: null,
    });
  });

  it('creates + binds past the old cap — the authoritative chokepoint no longer enforces org-size', async () => {
    // The cap that used to return null here is removed (M08). Even far over the
    // retired 25-agent limit, the create succeeds and the principal binds.
    process.env.NANOCLAW_MAX_AGENTS = '1';
    mockGetAllAgentGroups.mockReturnValue(new Array(100).fill({}));
    const notify = vi.fn();
    const created = await performCreateAgent('Scout', 'help', SESSION, SOURCE_GROUP, notify, {
      principalUserId: 'google:sub-123',
    });

    expect(created).not.toBeNull();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockAddMember).toHaveBeenCalledTimes(1);
    delete process.env.NANOCLAW_MAX_AGENTS;
  });
});
