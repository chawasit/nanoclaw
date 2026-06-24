import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetGroup = vi.fn();
const mockGetConfig = vi.fn();
const mockGetChildren = vi.fn();
const writes: Record<string, string> = {};

vi.mock('./config.js', () => ({ GROUPS_DIR: '/tmp/nanoclaw-test-groups' }));
vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: (id: string) => mockGetGroup(id) }));
vi.mock('./db/container-configs.js', () => ({ getContainerConfig: (id: string) => mockGetConfig(id) }));
vi.mock('./modules/agent-to-agent/db/agent-destinations.js', () => ({
  getChildAgentGroupIds: (id: string) => mockGetChildren(id),
}));
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

  it('leaves a gemma/ampere model env UNCHANGED (not a proxy family)', () => {
    mockGetConfig.mockReturnValue(baseRow({ model: 'unsloth/gemma-4-26B-A4B-it', env: '{"FOO":"bar"}' }));
    const cfg = materializeContainerJson('ag-test');
    expect(cfg.env).toEqual({ FOO: 'bar' });
    expect(cfg.blockedHosts).toEqual([]);
  });

  it('does NOT clobber an explicit ANTHROPIC_BASE_URL even on a proxy model (explicit wins)', () => {
    mockGetConfig.mockReturnValue(
      baseRow({
        model: 'glm-5.2',
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
