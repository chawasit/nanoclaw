import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockUpdate = vi.fn();

vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: (id: string) => mockGet(id),
  updateContainerConfigJson: (id: string, col: string, val: unknown) => mockUpdate(id, col, val),
}));
vi.mock('./config.js', () => ({ DATA_DIR: '/srv/nanoclaw/data' }));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { applyBaseProfile } from './base-profile.js';

const emptyRow = () => ({ mcp_servers: '{}', additional_mounts: '[]' });
const ID = 'ag-test-1';

beforeEach(() => {
  mockGet.mockReset();
  mockUpdate.mockReset();
  delete process.env.EXA_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.COMPANY_VAULT_PATH;
});
afterEach(() => {
  delete process.env.EXA_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.COMPANY_VAULT_PATH;
});

function updatesByCol() {
  const out: Record<string, unknown> = {};
  for (const [, col, val] of mockUpdate.mock.calls) out[col as string] = val;
  return out;
}

type Mount = { hostPath: string; containerPath: string; readonly: boolean };

describe('applyBaseProfile', () => {
  it('adds exa+firecrawl MCP and the tasklist mount when keys are present', () => {
    process.env.EXA_API_KEY = 'exa-key';
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    mockGet.mockReturnValue(emptyRow());

    applyBaseProfile(ID);

    const u = updatesByCol();
    const mcp = u.mcp_servers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    expect(mcp.exa.command).toBe('npx');
    expect(mcp.exa.args).toEqual(['-y', 'exa-mcp-server@3.2.1']);
    expect(mcp.exa.env.EXA_API_KEY).toBe('exa-key');
    expect(mcp.firecrawl.env.FIRECRAWL_API_KEY).toBe('fc-key');
    const mounts = u.additional_mounts as Mount[];
    expect(mounts).toEqual([{ hostPath: '/srv/nanoclaw/data/tasklist', containerPath: 'tasklist', readonly: true }]);
  });

  it('skips MCP servers gracefully when keys are absent (still mounts tasklist)', () => {
    mockGet.mockReturnValue(emptyRow());

    applyBaseProfile(ID);

    const u = updatesByCol();
    expect(u.mcp_servers).toBeUndefined();
    expect((u.additional_mounts as Mount[]).length).toBe(1);
  });

  it('adds the SOP vault mount when COMPANY_VAULT_PATH is set', () => {
    process.env.EXA_API_KEY = 'exa-key';
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    process.env.COMPANY_VAULT_PATH = '/srv/company-vault';
    mockGet.mockReturnValue(emptyRow());

    applyBaseProfile(ID);

    const mounts = updatesByCol().additional_mounts as Mount[];
    expect(mounts).toContainEqual({ hostPath: '/srv/company-vault', containerPath: 'sop', readonly: true });
    expect(mounts).toContainEqual({
      hostPath: '/srv/nanoclaw/data/tasklist',
      containerPath: 'tasklist',
      readonly: true,
    });
  });

  it('skips the SOP mount when COMPANY_VAULT_PATH is absent (graceful)', () => {
    mockGet.mockReturnValue(emptyRow());

    applyBaseProfile(ID);

    const mounts = updatesByCol().additional_mounts as Mount[];
    expect(mounts.some((m) => m.containerPath === 'sop')).toBe(false);
  });

  it('is idempotent — does not duplicate an existing server or mount', () => {
    process.env.EXA_API_KEY = 'exa-key';
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    process.env.COMPANY_VAULT_PATH = '/srv/company-vault';
    mockGet.mockReturnValue({
      mcp_servers: JSON.stringify({
        exa: { command: 'custom', args: [], env: {} },
        firecrawl: { command: 'custom', args: [], env: {} },
      }),
      additional_mounts: JSON.stringify([
        { hostPath: '/x', containerPath: 'tasklist', readonly: true },
        { hostPath: '/y', containerPath: 'sop', readonly: true },
      ]),
    });

    applyBaseProfile(ID);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('adds only the missing server (fills gaps, preserves existing)', () => {
    process.env.EXA_API_KEY = 'exa-key';
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    mockGet.mockReturnValue({
      mcp_servers: JSON.stringify({ exa: { command: 'keepme', args: [], env: {} } }),
      additional_mounts: '[]',
    });

    applyBaseProfile(ID);

    const mcp = updatesByCol().mcp_servers as Record<string, { command: string }>;
    expect(mcp.exa.command).toBe('keepme');
    expect(mcp.firecrawl.command).toBe('npx');
  });

  it('no-ops with a warning when the config row is missing', () => {
    mockGet.mockReturnValue(undefined);
    applyBaseProfile(ID);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
