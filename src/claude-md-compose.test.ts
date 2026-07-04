/**
 * G4 fix (MCP-Tools & Skills Management P1): `composeGroupClaudeMd` used to
 * emit a skill fragment for EVERY skill shipping `instructions.md` regardless
 * of the group's `container.json` skill selection (a stale TODO — the
 * selection was already enforced for symlinks/mounts by
 * `container-runner.ts`'s `syncSkillSymlinks`/`selectedSkillNames`, just not
 * for the CLAUDE.md fragments an agent actually reads). This mismatch meant
 * an agent could see instructions for a skill it had no files for (over-
 * selection was silently ignored).
 *
 * No DB needed — `getContainerConfig` is mocked, so this runs anywhere
 * (unlike the groups.ts CLI command tests, which need the compiled
 * better-sqlite3 binding).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerConfigRow } from './types.js';

const mockGetContainerConfig = vi.fn<(id: string) => ContainerConfigRow | undefined>();

vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: (id: string) => mockGetContainerConfig(id),
}));

let TEST_GROUPS_DIR: string;
let TEST_CWD: string;

vi.mock('./config.js', () => ({
  get GROUPS_DIR() {
    return TEST_GROUPS_DIR;
  },
}));

function configRow(skills: string): ContainerConfigRow {
  return {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills,
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    env: '{}',
    blocked_hosts: '[]',
    cli_scope: 'group',
    updated_at: new Date().toISOString(),
  };
}

describe('composeGroupClaudeMd respects container.json skill selection (G4)', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let symlinkSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-md-cwd-'));
    TEST_GROUPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-md-groups-'));

    // Two locally-shipped skills, both with an instructions.md fragment.
    for (const skill of ['skill-a', 'skill-b']) {
      const dir = path.join(TEST_CWD, 'container', 'skills', skill);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'instructions.md'), `# ${skill} instructions\n`);
    }

    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_CWD);

    // Real symlinks target dangling container paths (e.g. /app/skills/x) and
    // require elevated privileges on Windows (SeCreateSymbolicLinkPrivilege) —
    // unavailable in this sandbox but not on the Linux CI host this ships to.
    // Stand in with a plain marker file: what this test cares about is WHICH
    // fragment names get (re)written/pruned by the selection filter, not the
    // OS-level symlink mechanics (already covered by container-runner's own
    // syncSkillSymlinks, which this fix deliberately mirrors).
    symlinkSpy = vi
      .spyOn(fs, 'symlinkSync')
      .mockImplementation((target, linkPath) => fs.writeFileSync(linkPath as string, String(target)));
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    symlinkSpy.mockRestore();
    mockGetContainerConfig.mockReset();
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
    fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
  });

  function fragmentNames(folder: string): string[] {
    const dir = path.join(TEST_GROUPS_DIR, folder, '.claude-fragments');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  it('emits a fragment ONLY for skills in the selection array, not every shipped skill', async () => {
    mockGetContainerConfig.mockReturnValue(configRow('["skill-a"]'));
    const { composeGroupClaudeMd } = await import('./claude-md-compose.js');

    composeGroupClaudeMd({ id: 'ag-1', name: 'Test', folder: 'sel-array', agent_provider: null, created_at: '' });

    const frags = fragmentNames('sel-array');
    expect(frags).toContain('skill-skill-a.md');
    expect(frags).not.toContain('skill-skill-b.md');
  });

  it('emits fragments for every shipped skill when the selection is "all"', async () => {
    mockGetContainerConfig.mockReturnValue(configRow('"all"'));
    const { composeGroupClaudeMd } = await import('./claude-md-compose.js');

    composeGroupClaudeMd({ id: 'ag-1', name: 'Test', folder: 'sel-all', agent_provider: null, created_at: '' });

    const frags = fragmentNames('sel-all');
    expect(frags).toContain('skill-skill-a.md');
    expect(frags).toContain('skill-skill-b.md');
  });

  it('emits no skill fragments for an empty selection array', async () => {
    mockGetContainerConfig.mockReturnValue(configRow('[]'));
    const { composeGroupClaudeMd } = await import('./claude-md-compose.js');

    composeGroupClaudeMd({ id: 'ag-1', name: 'Test', folder: 'sel-empty', agent_provider: null, created_at: '' });

    const frags = fragmentNames('sel-empty').filter((f) => f.startsWith('skill-'));
    expect(frags).toEqual([]);
  });

  it('re-running with a narrowed selection prunes the now-deselected fragment (stale-fragment cleanup)', async () => {
    mockGetContainerConfig.mockReturnValue(configRow('"all"'));
    const { composeGroupClaudeMd } = await import('./claude-md-compose.js');

    composeGroupClaudeMd({ id: 'ag-1', name: 'Test', folder: 'sel-shrink', agent_provider: null, created_at: '' });
    expect(fragmentNames('sel-shrink')).toContain('skill-skill-b.md');

    mockGetContainerConfig.mockReturnValue(configRow('["skill-a"]'));
    composeGroupClaudeMd({ id: 'ag-1', name: 'Test', folder: 'sel-shrink', agent_provider: null, created_at: '' });

    const frags = fragmentNames('sel-shrink');
    expect(frags).toContain('skill-skill-a.md');
    expect(frags).not.toContain('skill-skill-b.md');
  });

  it('defaults to "all" (every shipped skill) when there is no container_configs row yet', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);
    const { composeGroupClaudeMd } = await import('./claude-md-compose.js');

    composeGroupClaudeMd({ id: 'ag-1', name: 'Test', folder: 'sel-norow', agent_provider: null, created_at: '' });

    const frags = fragmentNames('sel-norow');
    expect(frags).toContain('skill-skill-a.md');
    expect(frags).toContain('skill-skill-b.md');
  });
});
