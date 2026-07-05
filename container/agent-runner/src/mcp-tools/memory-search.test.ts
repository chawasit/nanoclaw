import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { memorySearch, __setMemoryDirForTest } from './memory-search.js';

let dir = '';

function write(name: string, content: string, mtimeDaysAgo?: number): void {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  if (mtimeDaysAgo !== undefined) {
    const t = new Date(Date.now() - mtimeDaysAgo * 86_400_000);
    fs.utimesSync(filePath, t, t);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-search-test-'));
  __setMemoryDirForTest(dir);
});

afterEach(() => {
  __setMemoryDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory_search handler', () => {
  it('returns a friendly message when the memory dir does not exist (never throws)', async () => {
    __setMemoryDirForTest(path.join(dir, 'does-not-exist'));
    const res = await memorySearch.handler({ query: 'anything' });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain('no memor');
  });

  it('returns a friendly message when the memory dir is empty', async () => {
    const res = await memorySearch.handler({ query: 'anything' });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain('no memor');
  });

  it('ranks a relevant fact above an unrelated one', async () => {
    write('deploy-runbook.md', 'How we deploy the backend: run the deploy script then restart the host runbook.', 0);
    write('coffee-preferences.md', 'The owner likes oat milk in the morning coffee.', 0);

    const res = await memorySearch.handler({ query: 'deploy runbook' });
    const text = (res.content[0] as { text: string }).text;
    expect(text.indexOf('deploy-runbook.md')).toBeLessThan(text.indexOf('coffee-preferences.md'));
  });

  it('reads optional confidence/importance frontmatter and falls back to defaults when absent', async () => {
    write(
      'high-confidence.md',
      ['---', 'metadata:', '  confidence: 0.95', '  importance: 0.9', '---', '', 'Deploy runbook details here.'].join('\n'),
      0,
    );
    write('no-frontmatter.md', 'Deploy runbook details here too, plainly.', 0);

    const res = await memorySearch.handler({ query: 'deploy runbook', limit: 5 });
    const text = (res.content[0] as { text: string }).text;
    // Both should surface (both relevant); the higher-confidence/importance one ranks first.
    expect(text.indexOf('high-confidence.md')).toBeLessThan(text.indexOf('no-frontmatter.md'));
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 8; i++) {
      write(`fact-${i}.md`, `deploy runbook fact number ${i}`, 0);
    }
    const res = await memorySearch.handler({ query: 'deploy runbook', limit: 3 });
    const text = (res.content[0] as { text: string }).text;
    const matches = text.match(/fact-\d\.md/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it('clamps an out-of-range limit instead of erroring', async () => {
    for (let i = 0; i < 25; i++) {
      write(`fact-${i}.md`, `deploy runbook fact number ${i}`, 0);
    }
    const res = await memorySearch.handler({ query: 'deploy runbook', limit: 500 });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    const matches = text.match(/fact-\d+\.md/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(20);
  });

  it('never ranks a zero-relevance fact above any nonzero-relevance fact (two-tier invariant)', async () => {
    // Zero relevance to the query, but very fresh + would otherwise score high on recency alone.
    write('unrelated-but-fresh.md', 'The office plant needs watering twice a week.', 0);
    // Only weakly relevant, old, low confidence/importance — but relevance > 0.
    write(
      'weakly-relevant-but-old.md',
      ['---', 'metadata:', '  confidence: 0.3', '  importance: 0.3', '---', '', 'A brief mention of the deploy process.'].join(
        '\n',
      ),
      200,
    );

    const res = await memorySearch.handler({ query: 'deploy process', limit: 2 });
    const text = (res.content[0] as { text: string }).text;
    expect(text.indexOf('weakly-relevant-but-old.md')).toBeLessThan(text.indexOf('unrelated-but-fresh.md'));
  });

  it('still returns zero-relevance facts as filler when fewer than `limit` facts actually match', async () => {
    write('unrelated.md', 'The office plant needs watering.', 0);
    const res = await memorySearch.handler({ query: 'deploy runbook', limit: 5 });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('unrelated.md');
  });

  it('only reads top-level *.md files, ignoring non-markdown files', async () => {
    write('note.md', 'deploy runbook note', 0);
    write('ignored.txt', 'deploy runbook but not markdown', 0);
    const res = await memorySearch.handler({ query: 'deploy runbook' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('note.md');
    expect(text).not.toContain('ignored.txt');
  });
});
