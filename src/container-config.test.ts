import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetGroup = vi.fn();
const mockGetConfig = vi.fn();
const mockGetChildren = vi.fn();
const mockGetMessagingGroup = vi.fn();
const mockGetDestinations = vi.fn();
const mockGetMembers = vi.fn();
const mockGetUser = vi.fn();
const writes: Record<string, string> = {};

vi.mock('./config.js', () => ({ GROUPS_DIR: '/tmp/nanoclaw-test-groups' }));
vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: (id: string) => mockGetGroup(id) }));
vi.mock('./db/container-configs.js', () => ({ getContainerConfig: (id: string) => mockGetConfig(id) }));
vi.mock('./db/messaging-groups.js', () => ({ getMessagingGroup: (id: string) => mockGetMessagingGroup(id) }));
vi.mock('./modules/agent-to-agent/db/agent-destinations.js', () => ({
  getChildAgentGroupIds: (id: string) => mockGetChildren(id),
  getDestinations: (id: string) => mockGetDestinations(id),
}));
// No bound human by default — primaryUser resolution short-circuits to undefined
// so existing proxy-env tests (which don't care about primaryUser) stay untouched.
vi.mock('./modules/permissions/db/agent-group-members.js', () => ({ getMembers: (id: string) => mockGetMembers(id) }));
vi.mock('./modules/permissions/db/users.js', () => ({ getUser: (id: string) => mockGetUser(id) }));
// Keep the workspace overlay inert (no COMPANY_NAS_PATH) and pass mounts through.
vi.mock('./leader-mounts.js', () => ({
  applyLeaderWorkspaceMounts: (mounts: unknown) => mounts,
}));
vi.mock('./leader-tools.js', () => ({ disallowedToolsForRole: () => [] }));
vi.mock('fs', () => ({
  default: {
    existsSync: () => true,
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string) => {
      writes[p] = data;
    },
  },
}));

import { materializeContainerJson } from './container-config.js';

const GROUP = { id: 'ag-test', name: 'Test', folder: 'test' };

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    image_tag: null,
    additional_mounts: '[]',
    env: '{}',
    blocked_hosts: '[]',
    skills: '[]',
    provider: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    model: null,
    effort: null,
    cli_scope: null,
    ...overrides,
  };
}

describe('materializeContainerJson proxy-env auto-injection', () => {
  beforeEach(() => {
    mockGetGroup.mockReturnValue(GROUP);
    mockGetChildren.mockReturnValue([]); // not a leader
    mockGetMembers.mockReturnValue([]); // no bound human by default
    process.env.NANOCLAW_PROXY_BASE_URL = 'http://192.168.1.37:4000';
    process.env.NANOCLAW_PROXY_API_KEY = 'sk-test-master';
  });
  afterEach(() => {
    delete process.env.NANOCLAW_PROXY_BASE_URL;
    delete process.env.NANOCLAW_PROXY_API_KEY;
    vi.clearAllMocks();
  });

  it('injects proxy env + blocks api.anthropic.com for a proxy model with empty env', () => {
    mockGetConfig.mockReturnValue(baseRow({ model: 'gemini-3.1-pro', env: '{}' }));
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.env?.ANTHROPIC_BASE_URL).toBe('http://192.168.1.37:4000');
    expect(cfg.env?.ANTHROPIC_API_KEY).toBe('sk-test-master');
    expect(cfg.env?.NO_PROXY).toBe('192.168.1.37');
    expect(cfg.env?.no_proxy).toBe('192.168.1.37');
    expect(cfg.blockedHosts).toContain('api.anthropic.com');
  });

  it('injects proxy env for a gemma model (gemma-4 is a LiteLLM route since 2026-06-24)', () => {
    mockGetConfig.mockReturnValue(baseRow({ model: 'gemma-4', env: '{"FOO":"bar"}' }));
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.env?.ANTHROPIC_BASE_URL).toBe('http://192.168.1.37:4000');
    expect(cfg.env?.FOO).toBe('bar');
    expect(cfg.blockedHosts).toContain('api.anthropic.com');
  });

  it('leaves a DIRECT-ampere gemma agent untouched (explicit base URL wins over the proxy)', () => {
    mockGetConfig.mockReturnValue(
      baseRow({
        model: 'unsloth/gemma-4-26B-A4B-it',
        env: '{"ANTHROPIC_BASE_URL":"http://192.168.1.31:11434","ANTHROPIC_API_KEY":"ollama"}',
        blocked_hosts: '[]',
      }),
    );
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.env?.ANTHROPIC_BASE_URL).toBe('http://192.168.1.31:11434');
    expect(cfg.env?.ANTHROPIC_API_KEY).toBe('ollama');
    expect(cfg.blockedHosts).toEqual([]); // not touched
  });

  it('no-op when the spine has no proxy config (env-gated)', () => {
    delete process.env.NANOCLAW_PROXY_BASE_URL;
    delete process.env.NANOCLAW_PROXY_API_KEY;
    mockGetConfig.mockReturnValue(baseRow({ model: 'glm-5.2', env: '{}' }));
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(cfg.blockedHosts).toEqual([]);
  });

  it('does not duplicate api.anthropic.com if already blocked', () => {
    mockGetConfig.mockReturnValue(baseRow({ model: 'gpt-5.5', env: '{}', blocked_hosts: '["api.anthropic.com"]' }));
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.blockedHosts?.filter((h) => h === 'api.anthropic.com')).toHaveLength(1);
  });
});

describe('materializeContainerJson primaryUser resolution', () => {
  beforeEach(() => {
    mockGetGroup.mockReturnValue(GROUP);
    mockGetChildren.mockReturnValue([]);
    mockGetConfig.mockReturnValue(baseRow());
    delete process.env.NANOCLAW_PROXY_BASE_URL;
    delete process.env.NANOCLAW_PROXY_API_KEY;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('populates primaryUser from the earliest bound member + their cli reply lane', () => {
    mockGetMembers.mockReturnValue([{ user_id: 'google:123', agent_group_id: 'ag-test', added_by: null, added_at: 't0' }]);
    mockGetUser.mockReturnValue({ id: 'google:123', kind: 'google', display_name: 'alice@trirat.co', created_at: 't0' });
    mockGetDestinations.mockReturnValue([
      { agent_group_id: 'ag-test', local_name: 'parent', target_type: 'agent', target_id: 'ag-cos', created_at: 't0' },
      { agent_group_id: 'ag-test', local_name: 'user', target_type: 'channel', target_id: 'mg-1', created_at: 't0' },
    ]);
    mockGetMessagingGroup.mockImplementation((id: string) =>
      id === 'mg-1' ? { id: 'mg-1', channel_type: 'cli', platform_id: 'web:google:123', instance: 'cli' } : undefined,
    );

    const cfg = materializeContainerJson('ag-test');

    expect(cfg.primaryUser).toEqual({
      name: 'alice@trirat.co',
      email: 'alice@trirat.co',
      destination: 'user',
    });
  });

  it('omits primaryUser when the group has no bound human', () => {
    mockGetMembers.mockReturnValue([]);
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.primaryUser).toBeUndefined();
  });

  it('omits primaryUser when the bound human has no resolvable cli reply lane', () => {
    mockGetMembers.mockReturnValue([{ user_id: 'google:123', agent_group_id: 'ag-test', added_by: null, added_at: 't0' }]);
    mockGetUser.mockReturnValue({ id: 'google:123', kind: 'google', display_name: 'alice@trirat.co', created_at: 't0' });
    mockGetDestinations.mockReturnValue([
      { agent_group_id: 'ag-test', local_name: 'parent', target_type: 'agent', target_id: 'ag-cos', created_at: 't0' },
    ]);
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.primaryUser).toBeUndefined();
  });
});
