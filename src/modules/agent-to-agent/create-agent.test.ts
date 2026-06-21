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

import { handleCreateAgent, applyCreateAgent } from './create-agent.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

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

describe('handleCreateAgent — recruiting headcount caps (Path A slice 1)', () => {
  it('default caps (env unset): a normal hire proceeds', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    // getAllAgentGroups → [] and countChildren → 0 by default (beforeEach)
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('global headcount cap: denies even a trusted global-scope creator, with no approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockGetAllAgentGroups.mockReturnValue(new Array(25).fill({})); // == DEFAULT_MAX_AGENTS
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockNotifyWrite).toHaveBeenCalled(); // told the agent why
  });

  it('direct-report cap: denies when the creator already has the max children', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockCountChildren.mockReturnValue(10); // == DEFAULT_MAX_DIRECT_REPORTS
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('confined (group) scope over cap: denied EARLY — no approval is requested', async () => {
    // Pins the handleCreateAgent early check: a doomed hire must not bother an admin.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetAllAgentGroups.mockReturnValue(new Array(25).fill({}));
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('allow boundary: one slot under each cap still proceeds (off-by-one guard)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockGetAllAgentGroups.mockReturnValue(new Array(24).fill({})); // 24 < 25
    mockCountChildren.mockReturnValue(9); // 9 < 10
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('deny message explains the cap (not an empty/garbled notice)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockGetAllAgentGroups.mockReturnValue(new Array(25).fill({}));
    await handleCreateAgent({ name: 'Scout', instructions: 'x' }, SESSION);
    const msg = JSON.parse((mockNotifyWrite.mock.calls[0][2] as { content: string }).content).text as string;
    expect(msg).toContain('headcount cap');
  });

  it('confined path is capped at CREATION (applyCreateAgent), not only at request time', async () => {
    // The cap must hold even if the request slipped under at approval time and
    // headcount filled up before the admin approved.
    mockGetAllAgentGroups.mockReturnValue(new Array(25).fill({}));
    const notify = vi.fn();
    await applyCreateAgent({ session: SESSION, payload: { name: 'Scout' }, notify } as never);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });
});
