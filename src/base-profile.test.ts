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
});
afterEach(() => {
  delete process.env.EXA_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

function updatesByCol() {
  const out: Record<string, unknown> = {};
  for (const [, col, val] of mockUpdate.mock.calls) out[col as string] = val;
  return out;
}

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
    const mounts = u.additional_mounts as Array<{ containerPath: string; readonly: boolean; hostPath: string }>;
    expect(mounts).toEqual([{ hostPath: '/srv/nanoclaw/data/tasklist', containerPath: 'tasklist', readonly: true }]);
  });

  it('skips MCP servers gracefully when keys are absent (still mounts tasklist)', () => {
    mockGet.mockReturnValue(emptyRow());

    applyBaseProfile(ID);

    const u = updatesByCol();
    expect(u.mcp_servers).toBeUndefined(); // no mcp write at all
    expect((u.additional_mounts as unknown[]).length).toBe(1);
  });

  it('is idempotent — does not duplicate an existing server or mount', () => {
    process.env.EXA_API_KEY = 'exa-key';
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    mockGet.mockReturnValue({
      mcp_servers: JSON.stringify({
        exa: { command: 'custom', args: [], env: {} },
        firecrawl: { command: 'custom', args: [], env: {} },
      }),
      additional_mounts: JSON.stringify([{ hostPath: '/x', containerPath: 'tasklist', readonly: true }]),
    });

    applyBaseProfile(ID);

    expect(mockUpdate).not.toHaveBeenCalled(); // nothing to add
  });

  it('adds only the missing server (fills gaps, preserves existing)', () => {
    process.env.EXA_API_KEY = 'exa-key';
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    mockGet.mockReturnValue({
      mcp_servers: JSON.stringify({ exa: { command: 'keepme', args: [], env: {} } }),
      additional_mounts: '[]',
    });

    applyBaseProfile(ID);

    const u = updatesByCol();
    const mcp = u.mcp_servers as Record<string, { command: string }>;
    expect(mcp.exa.command).toBe('keepme'); // preserved
    expect(mcp.firecrawl.command).toBe('npx'); // added
  });

  it('no-ops with a warning when the config row is missing', () => {
    mockGet.mockReturnValue(undefined);
    applyBaseProfile(ID);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
