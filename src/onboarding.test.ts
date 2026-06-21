import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let files: Record<string, string>;
const mockRead = vi.fn((p: string) => {
  if (p in files) return files[p];
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
});
const mockWrite = vi.fn((p: string, c: string) => {
  files[p] = c;
});

vi.mock('fs', () => ({
  default: {
    readFileSync: (p: string) => mockRead(p),
    writeFileSync: (p: string, c: string) => mockWrite(p, c),
    mkdirSync: vi.fn(),
  },
}));
vi.mock('./config.js', () => ({ GROUPS_DIR: '/srv/groups' }));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { seedOnboarding, renderOnboardingBlock } from './onboarding.js';

const group = (folder: string, id = 'ag-1') => ({
  id,
  name: folder,
  folder,
  agent_provider: null,
  created_at: '2026-01-01',
});
const FILE = '/srv/groups/w1/CLAUDE.local.md';

beforeEach(() => {
  files = {};
  mockRead.mockClear();
  mockWrite.mockClear();
  process.env.COMPANY_NAS_PATH = '/srv/company-nas';
});
afterEach(() => {
  delete process.env.COMPANY_NAS_PATH;
});

describe('seedOnboarding', () => {
  it('appends the onboarding block when COMPANY_NAS_PATH is set', () => {
    files[FILE] = '# role brief\n';
    seedOnboarding(group('w1'));
    expect(files[FILE]).toContain('## First-run onboarding');
    expect(files[FILE]).toContain('/workspace/extra/vault/sop/agent-workspace.md');
    expect(files[FILE]).toContain('# role brief'); // preserves existing content
  });

  it('is inert when COMPANY_NAS_PATH is unset (no NAS → no directive)', () => {
    delete process.env.COMPANY_NAS_PATH;
    files[FILE] = '# role brief\n';
    seedOnboarding(group('w1'));
    expect(mockWrite).not.toHaveBeenCalled();
    expect(files[FILE]).toBe('# role brief\n');
  });

  it('is idempotent — does not double-append', () => {
    files[FILE] = '# role brief\n';
    seedOnboarding(group('w1'));
    const after = files[FILE];
    seedOnboarding(group('w1'));
    expect(files[FILE]).toBe(after);
    expect((files[FILE].match(/## First-run onboarding/g) || []).length).toBe(1);
  });

  it('seeds fresh when CLAUDE.local.md does not exist yet', () => {
    seedOnboarding(group('w1'));
    expect(files[FILE]).toContain('## First-run onboarding');
  });

  it('renders a bounded reading list (not "study everything")', () => {
    const block = renderOnboardingBlock();
    expect(block).toContain('base-agent-contract');
    expect(block).toContain('status-reporting');
    expect(block).toContain('## Onboarding'); // tells the agent to record a durable note
  });
});
