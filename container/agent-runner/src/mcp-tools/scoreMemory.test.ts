import { describe, it, expect } from 'bun:test';

import { relevance, parseFrontmatter, scoreMemory, DEFAULT_CONFIDENCE, DEFAULT_IMPORTANCE, RECENCY_FLOOR } from './scoreMemory.js';

describe('relevance()', () => {
  it('scores 0 when no query terms appear in the text', () => {
    expect(relevance('kubernetes cluster', 'the owner likes coffee in the morning')).toBe(0);
  });

  it('is case-insensitive', () => {
    const lower = relevance('memory search', 'the memory search tool ranks facts');
    const mixed = relevance('MEMORY Search', 'The Memory SEARCH tool ranks facts');
    expect(mixed).toBe(lower);
    expect(lower).toBeGreaterThan(0);
  });

  it('drops stopwords and short tokens so they do not inflate coverage', () => {
    // "is", "a", "of" are stopwords/too short; only "deploy" and "runbook" count.
    const withStopwords = relevance('is a deploy of the runbook', 'we wrote the deploy runbook last week');
    const bareTerms = relevance('deploy runbook', 'we wrote the deploy runbook last week');
    expect(withStopwords).toBe(bareTerms);
  });

  it('rewards full term coverage over partial coverage', () => {
    const full = relevance('deploy runbook host', 'deploy runbook host instructions');
    const partial = relevance('deploy runbook host', 'deploy instructions only');
    expect(full).toBeGreaterThan(partial);
  });

  it('caps term-frequency contribution so one repeated word cannot dominate', () => {
    const repeatedFew = relevance('deploy', 'deploy deploy deploy');
    const repeatedMany = relevance('deploy', 'deploy '.repeat(50));
    expect(repeatedMany).toBe(repeatedFew); // both hit the TF cap — same score
  });

  it('returns a value in [0,1]', () => {
    const r = relevance('deploy runbook', 'deploy runbook deploy runbook deploy runbook');
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThan(0);
  });

  it('returns 0 for an empty query', () => {
    expect(relevance('', 'anything at all')).toBe(0);
  });
});

describe('parseFrontmatter()', () => {
  it('parses confidence and importance when both are present under metadata', () => {
    const raw = ['---', 'metadata:', '  confidence: 0.9', '  importance: 0.8', '---', '', 'The body text.'].join('\n');
    const { metadata, body } = parseFrontmatter(raw);
    expect(metadata.confidence).toBe(0.9);
    expect(metadata.importance).toBe(0.8);
    expect(body.trim()).toBe('The body text.');
  });

  it('falls back to the default for a missing field', () => {
    const raw = ['---', 'metadata:', '  confidence: 0.95', '---', '', 'Body.'].join('\n');
    const { metadata } = parseFrontmatter(raw);
    expect(metadata.confidence).toBe(0.95);
    expect(metadata.importance).toBe(DEFAULT_IMPORTANCE);
  });

  it('falls back to both defaults when frontmatter is entirely absent', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.';
    const { metadata, body } = parseFrontmatter(raw);
    expect(metadata.confidence).toBe(DEFAULT_CONFIDENCE);
    expect(metadata.importance).toBe(DEFAULT_IMPORTANCE);
    expect(body).toBe(raw);
  });

  it('falls back to both defaults on a malformed frontmatter block (no closing ---)', () => {
    const raw = ['---', 'metadata:', '  confidence: 0.9', '', '# Heading', 'Body without a closing delimiter.'].join('\n');
    const { metadata, body } = parseFrontmatter(raw);
    expect(metadata.confidence).toBe(DEFAULT_CONFIDENCE);
    expect(metadata.importance).toBe(DEFAULT_IMPORTANCE);
    expect(body).toBe(raw); // treated as opaque — never throws, never guesses
  });

  it('never throws on garbage input', () => {
    expect(() => parseFrontmatter('---\n:::: not yaml at all ::::\n---\nbody')).not.toThrow();
  });
});

describe('scoreMemory()', () => {
  it('decays score as ageDays grows, but respects the recency floor', () => {
    const fresh = scoreMemory({ relevance: 0.8, confidence: 0.7, importance: 0.5, ageDays: 0 });
    const old = scoreMemory({ relevance: 0.8, confidence: 0.7, importance: 0.5, ageDays: 365 });
    const ancient = scoreMemory({ relevance: 0.8, confidence: 0.7, importance: 0.5, ageDays: 100000 });
    expect(old.score).toBeLessThan(fresh.score);
    expect(ancient.breakdown.recencyFactor).toBeCloseTo(RECENCY_FLOOR, 5);
    expect(ancient.score).toBeGreaterThan(0); // floor keeps it from ever hitting 0
  });

  it('raises the score as confidence or importance rise, all else equal', () => {
    const lowConf = scoreMemory({ relevance: 0.5, confidence: 0.2, importance: 0.5, ageDays: 10 });
    const highConf = scoreMemory({ relevance: 0.5, confidence: 0.9, importance: 0.5, ageDays: 10 });
    expect(highConf.score).toBeGreaterThan(lowConf.score);

    const lowImp = scoreMemory({ relevance: 0.5, confidence: 0.5, importance: 0.1, ageDays: 10 });
    const highImp = scoreMemory({ relevance: 0.5, confidence: 0.5, importance: 0.9, ageDays: 10 });
    expect(highImp.score).toBeGreaterThan(lowImp.score);
  });

  it('weighs relevance heavily enough that a low-relevance fact scores below a higher-relevance one, even when confidence/importance/recency all favor the low-relevance fact', () => {
    const lowRelevanceButOtherwiseIdeal = scoreMemory({
      relevance: 0.1,
      confidence: 1.0,
      importance: 1.0,
      ageDays: 0, // fully fresh — best possible recency
    });
    const higherRelevanceButOtherwiseWeak = scoreMemory({
      relevance: 0.9,
      confidence: 0.1,
      importance: 0.1,
      ageDays: 30, // a month old — worse recency than the fact above
    });
    expect(higherRelevanceButOtherwiseWeak.score).toBeGreaterThan(lowRelevanceButOtherwiseIdeal.score);
  });
});
