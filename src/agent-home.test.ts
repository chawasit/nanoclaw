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

vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => mockExists(p),
    readFileSync: (p: string) => mockRead(p),
    writeFileSync: (p: string, c: string) => mockWrite(p, c),
    mkdirSync: vi.fn(),
  },
}));

import {
  applyPrimaryUserToUserFile,
  renderAgentHomeManual,
  renderBootstrapTemplate,
  renderIdentityTemplate,
  renderMemoryTemplate,
  renderSoulTemplate,
  renderUserTemplate,
  seedAgentHomeFiles,
  upsertAgentHomeManual,
  USER_ADDRESS_PLACEHOLDER,
  USER_EMAIL_PLACEHOLDER,
  USER_NAME_PLACEHOLDER,
} from './agent-home.js';

const GROUP_DIR = '/srv/groups/w1';
// agent-home.ts builds file paths with `path.join(groupDir, filename)` — mirror
// that exactly so expected keys match on every OS (Windows' path.join uses `\`).
const f = (name: string) => path.join(GROUP_DIR, name);

// Every `/workspace/...` reference any template makes, so a single regex sweep
// can assert "no bare .md / bare dir mention anywhere" (the reviewer's hard
// acceptance check — see docs/agent-home-memory-orientation-spec.md §0).
const ALL_TEMPLATES = () => [
  renderIdentityTemplate(),
  renderUserTemplate(),
  renderSoulTemplate(),
  renderMemoryTemplate(),
  renderBootstrapTemplate(),
  renderAgentHomeManual(),
];

/** Every `something.md` path token that does NOT start with `/workspace`. */
function bareMdReferences(text: string): string[] {
  const tokens = [...text.matchAll(/(?:^|[\s(`'"])([\w./-]+\.md)\b/g)].map((m) => m[1]);
  return tokens.filter((token) => !token.startsWith('/workspace'));
}

beforeEach(() => {
  files = {};
  mockRead.mockClear();
  mockWrite.mockClear();
  mockExists.mockClear();
});

describe('FULL PATHS acceptance check (owner rule — no bare .md mentions)', () => {
  it('every .md reference in every seeded template is a full /workspace/... path', () => {
    for (const template of ALL_TEMPLATES()) {
      expect(bareMdReferences(template)).toEqual([]);
    }
  });
});

describe('renderIdentityTemplate', () => {
  it('is a stub with Name/Role/Vibe/Emoji', () => {
    const t = renderIdentityTemplate();
    expect(t).toContain('Name');
    expect(t).toContain('Role');
    expect(t).toContain('Vibe');
    expect(t).toContain('Emoji');
  });
});

describe('renderUserTemplate', () => {
  it('contains the three placeholder lines that get backfilled from primaryUser', () => {
    const t = renderUserTemplate();
    expect(t).toContain(USER_NAME_PLACEHOLDER);
    expect(t).toContain(USER_ADDRESS_PLACEHOLDER);
    expect(t).toContain(USER_EMAIL_PLACEHOLDER);
    expect(t).toContain('Timezone');
    expect(t).toContain('## Notes');
    expect(t).toContain('## Context');
  });
});

describe('renderSoulTemplate', () => {
  it('includes company core truths + the continuity note', () => {
    const t = renderSoulTemplate();
    expect(t).toContain('guest with access');
    expect(t).toContain('## Continuity');
    expect(t).toContain('/workspace/agent/MEMORY.md');
  });
});

describe('renderBootstrapTemplate', () => {
  it('instructs confirming IDENTITY/USER/SOUL then deleting its own full path', () => {
    const t = renderBootstrapTemplate();
    expect(t).toContain('/workspace/agent/IDENTITY.md');
    expect(t).toContain('/workspace/agent/USER.md');
    expect(t).toContain('/workspace/agent/SOUL.md');
    expect(t).toContain('Remove `/workspace/agent/BOOTSTRAP.md`');
  });
});

describe('renderAgentHomeManual', () => {
  it('includes all 7 sections with full-path examples', () => {
    const m = renderAgentHomeManual();
    expect(m).toContain('### 1. Where you live');
    expect(m).toContain('### 2. How to communicate');
    expect(m).toContain('### 3. Your memory');
    expect(m).toContain('### 4. Documentation methodology');
    expect(m).toContain('### 5. Tools');
    expect(m).toContain('### 6. Workflow');
    expect(m).toContain('### 7. First run');
    expect(m).toContain('send_file({ path: "/workspace/agent/reports/2026-07-05-market-research.md" })');
    expect(m).toContain(`send_message({ to: "parent", text:`);
    expect(m).toContain('/workspace/extra/vault/');
  });
});

describe('seedAgentHomeFiles', () => {
  it('writes all five stub files when none exist', () => {
    const written = seedAgentHomeFiles(GROUP_DIR);
    expect(written.sort()).toEqual(['BOOTSTRAP.md', 'IDENTITY.md', 'MEMORY.md', 'SOUL.md', 'USER.md'].sort());
    expect(files[f('IDENTITY.md')]).toBeDefined();
    expect(files[f('USER.md')]).toBeDefined();
    expect(files[f('SOUL.md')]).toBeDefined();
    expect(files[f('MEMORY.md')]).toBeDefined();
    expect(files[f('BOOTSTRAP.md')]).toBeDefined();
  });

  it('never overwrites a file that already exists (agent edits win)', () => {
    files[f('IDENTITY.md')] = '# Identity\n\n- **Name:** Aria\n';
    const written = seedAgentHomeFiles(GROUP_DIR);
    expect(written).not.toContain('IDENTITY.md');
    expect(files[f('IDENTITY.md')]).toBe('# Identity\n\n- **Name:** Aria\n');
  });

  it('is idempotent — a second call writes nothing further', () => {
    seedAgentHomeFiles(GROUP_DIR);
    mockWrite.mockClear();
    const written = seedAgentHomeFiles(GROUP_DIR);
    expect(written).toEqual([]);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('upsertAgentHomeManual', () => {
  const file = f('CLAUDE.local.md');

  it('appends the manual block below an existing mandate seed', () => {
    files[file] = 'You are the data analyst. Report to the MD.\n';
    upsertAgentHomeManual(GROUP_DIR);
    expect(files[file]).toContain('data analyst');
    expect(files[file]).toContain('<!-- agent-home-manual:start -->');
    expect(files[file].indexOf('data analyst')).toBeLessThan(files[file].indexOf('agent-home-manual:start'));
  });

  it('creates CLAUDE.local.md fresh when none exists', () => {
    upsertAgentHomeManual(GROUP_DIR);
    expect(files[file]).toContain('### 1. Where you live');
  });

  it('is idempotent — a second call with no upstream changes writes nothing', () => {
    upsertAgentHomeManual(GROUP_DIR);
    mockWrite.mockClear();
    const wrote = upsertAgentHomeManual(GROUP_DIR);
    expect(wrote).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('regenerates (replaces) a stale manual block on re-seed without touching other content', () => {
    files[file] = [
      'Mandate text stays.',
      '',
      '<!-- agent-home-manual:start -->',
      'stale content from an older template',
      '<!-- agent-home-manual:end -->',
    ].join('\n');
    upsertAgentHomeManual(GROUP_DIR);
    expect(files[file]).toContain('Mandate text stays.');
    expect(files[file]).not.toContain('stale content from an older template');
    expect(files[file]).toContain('### 1. Where you live');
    expect(files[file].split('agent-home-manual:start').length - 1).toBe(1);
  });

  it('preserves the personality + onboarding blocks that sit above it', () => {
    files[file] = [
      'Mandate.',
      '',
      '<!-- base-personality -->',
      '## Working style',
      'terse, cautious',
      '',
      '<!-- base-onboarding -->',
      '## First-run onboarding (do once)',
    ].join('\n');
    upsertAgentHomeManual(GROUP_DIR);
    expect(files[file]).toContain('<!-- base-personality -->');
    expect(files[file]).toContain('<!-- base-onboarding -->');
    expect(files[file]).toContain('### 1. Where you live');
  });
});

describe('applyPrimaryUserToUserFile', () => {
  const file = f('USER.md');

  it('replaces the three placeholders with the resolved primary user', () => {
    files[file] = renderUserTemplate();
    const wrote = applyPrimaryUserToUserFile(GROUP_DIR, {
      name: 'alice@trirat.co',
      email: 'alice@trirat.co',
      destination: 'user',
    });
    expect(wrote).toBe(true);
    expect(files[file]).toContain('- **Name:** alice@trirat.co');
    expect(files[file]).toContain('- **How to address them:** alice@trirat.co');
    expect(files[file]).toContain('- **Email:** alice@trirat.co');
  });

  it('fills Email with "(not provided)" when the primary user has no email', () => {
    files[file] = renderUserTemplate();
    applyPrimaryUserToUserFile(GROUP_DIR, { name: 'Bob', destination: 'user' });
    expect(files[file]).toContain('- **Email:** (not provided)');
  });

  it('never overwrites a line the agent has already deepened', () => {
    files[file] = renderUserTemplate().replace(USER_NAME_PLACEHOLDER, '- **Name:** Alice (deepened by agent)');
    applyPrimaryUserToUserFile(GROUP_DIR, { name: 'someone-else', destination: 'user' });
    expect(files[file]).toContain('- **Name:** Alice (deepened by agent)');
  });

  it('is idempotent — re-applying the same primary user is a no-op write', () => {
    files[file] = renderUserTemplate();
    applyPrimaryUserToUserFile(GROUP_DIR, { name: 'Alice', destination: 'user' });
    mockWrite.mockClear();
    const wrote = applyPrimaryUserToUserFile(GROUP_DIR, { name: 'Alice', destination: 'user' });
    expect(wrote).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns false when USER.md does not exist yet', () => {
    const wrote = applyPrimaryUserToUserFile(GROUP_DIR, { name: 'Alice', destination: 'user' });
    expect(wrote).toBe(false);
  });
});
