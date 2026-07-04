import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let files: Record<string, string>;
const mockRead = vi.fn((p: string) => {
  if (p in files) return files[p];
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
});
const mockWrite = vi.fn((p: string, c: string) => {
  files[p] = c;
});
const mockExists = vi.fn((p: string) => p in files);
const mockRm = vi.fn((p: string) => {
  delete files[p];
});
const mockEnsureContainerConfig = vi.fn();
const mockProvidesAgentSurfaces = vi.fn((_name?: string | null) => false);

// vi.mock factories are hoisted above module-scope consts, so the mocked
// values must be defined via vi.hoisted() to survive the hoist.
const { GROUPS_DIR_MOCK, DATA_DIR_MOCK } = vi.hoisted(() => ({
  GROUPS_DIR_MOCK: '/srv/groups',
  DATA_DIR_MOCK: '/srv/data',
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => mockExists(p),
    readFileSync: (p: string) => mockRead(p),
    writeFileSync: (p: string, c: string) => mockWrite(p, c),
    mkdirSync: vi.fn((p: string) => {
      files[p] = files[p] ?? ''; // mark directories as "existing" too
    }),
    rmSync: (p: string) => mockRm(p),
  },
}));
vi.mock('./config.js', () => ({ GROUPS_DIR: GROUPS_DIR_MOCK, DATA_DIR: DATA_DIR_MOCK }));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('./db/container-configs.js', () => ({ ensureContainerConfig: (id: string) => mockEnsureContainerConfig(id) }));
vi.mock('./providers/provider-container-registry.js', () => ({
  providerProvidesAgentSurfaces: (name: string | null | undefined) => mockProvidesAgentSurfaces(name),
}));

import { initGroupFilesystem } from './group-init.js';

const group = (folder: string, id = 'ag-1') => ({
  id,
  name: folder,
  folder,
  agent_provider: null,
  created_at: '2026-01-01',
});

// group-init.ts computes the group dir with `path.resolve(GROUPS_DIR, folder)`
// (not `path.join`) — mirror that exactly so keys match on every OS (path.resolve
// prefixes a drive letter on win32, which a hardcoded literal would miss).
const groupDir = (folder: string) => path.resolve(GROUPS_DIR_MOCK, folder);
const homeFile = (folder: string, name: string) => path.join(groupDir(folder), name);

beforeEach(() => {
  files = {};
  mockRead.mockClear();
  mockWrite.mockClear();
  mockExists.mockClear();
  mockRm.mockClear();
  mockEnsureContainerConfig.mockClear();
  mockProvidesAgentSurfaces.mockReturnValue(false);
});

describe('initGroupFilesystem — Agent Home seeding', () => {
  it('seeds IDENTITY/USER/SOUL/MEMORY/BOOTSTRAP.md alongside CLAUDE.local.md for default surfaces', () => {
    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });

    expect(files[homeFile('w1', 'CLAUDE.local.md')]).toContain('You are the data analyst.');
    expect(files[homeFile('w1', 'IDENTITY.md')]).toBeDefined();
    expect(files[homeFile('w1', 'USER.md')]).toBeDefined();
    expect(files[homeFile('w1', 'SOUL.md')]).toBeDefined();
    expect(files[homeFile('w1', 'MEMORY.md')]).toBeDefined();
    expect(files[homeFile('w1', 'BOOTSTRAP.md')]).toBeDefined();
  });

  it('appends the operating-manual block to CLAUDE.local.md after the mandate seed', () => {
    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });
    const manual = files[homeFile('w1', 'CLAUDE.local.md')];
    expect(manual.indexOf('You are the data analyst.')).toBeLessThan(manual.indexOf('agent-home-manual:start'));
    expect(manual).toContain('### 1. Where you live');
  });

  it('is idempotent — re-running on an already-initialized group never overwrites the agent-edited stub body', () => {
    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });
    files[homeFile('w1', 'IDENTITY.md')] = '# Identity\n\n- **Name:** Aria (already bootstrapped)\n';

    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });

    // The describe-header is refreshed on every call (upsertFileHeaders), but the agent's own
    // edit below it is never touched.
    expect(files[homeFile('w1', 'IDENTITY.md')]).toContain('# Identity\n\n- **Name:** Aria (already bootstrapped)\n');

    // A further call is a true no-op — the header itself does not keep re-appending.
    const before = files[homeFile('w1', 'IDENTITY.md')];
    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });
    expect(files[homeFile('w1', 'IDENTITY.md')]).toBe(before);
  });

  it('regenerates the manual block on a later call (template refresh) without dropping agent notes', () => {
    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });
    files[homeFile('w1', 'CLAUDE.local.md')] += '\n## My own notes\nRemember to check the Q3 numbers.\n';

    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });

    const manual = files[homeFile('w1', 'CLAUDE.local.md')];
    expect(manual).toContain('My own notes');
    expect(manual).toContain('Remember to check the Q3 numbers.');
    expect(manual.split('agent-home-manual:start').length - 1).toBe(1);
  });

  it('does NOT seed Agent Home files for a surfaces-owning provider', () => {
    mockProvidesAgentSurfaces.mockReturnValue(true);
    initGroupFilesystem(group('w1'), { instructions: 'hello', provider: 'surfaces-test-provider' });

    expect(files[homeFile('w1', 'IDENTITY.md')]).toBeUndefined();
    expect(files[homeFile('w1', 'USER.md')]).toBeUndefined();
    expect(files[homeFile('w1', 'CLAUDE.local.md')]).toBeUndefined();
  });
});

describe('FULL PATHS acceptance check — the seeded CLAUDE.local.md manual', () => {
  it('never mentions a bare filename — every .md / directory reference is a full /workspace/... path', () => {
    initGroupFilesystem(group('w1'), { instructions: 'You are the data analyst.' });
    const manual = files[homeFile('w1', 'CLAUDE.local.md')];

    // Every `.md` mention must resolve as a full `/workspace/...` path token.
    const tokens = [...manual.matchAll(/(?:^|[\s(`'"])([\w./-]+\.md)\b/g)].map((m) => m[1]);
    const bareMd = tokens.filter((token) => !token.startsWith('/workspace'));
    expect(bareMd).toEqual([]);

    // Spot-check the load-bearing full-path references called out by the spec.
    for (const ref of [
      '/workspace/agent/USER.md',
      '/workspace/agent/SOUL.md',
      '/workspace/agent/MEMORY.md',
      '/workspace/agent/IDENTITY.md',
      '/workspace/agent/BOOTSTRAP.md',
      '/workspace/agent/CLAUDE.local.md',
      '/workspace/inbox/',
      '/workspace/outbox/',
    ]) {
      expect(manual).toContain(ref);
    }
  });
});
