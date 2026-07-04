import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP = '';
vi.mock('./config.js', () => ({
  get GROUPS_DIR() {
    return TMP;
  },
}));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import {
  PERSONALITY_AXES,
  renderPersonalityBlock,
  rngForId,
  samplePersonality,
  seedPersonality,
} from './personality.js';

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const group = (folder: string, id = 'ag-x') => ({ id, folder }) as any;
const soulFile = (folder: string) => path.join(TMP, folder, 'SOUL.md');
const flavor = (id: string) => Object.values(samplePersonality(rngForId(id))).join(',');

describe('samplePersonality', () => {
  it('returns exactly one pole per axis', () => {
    const t = samplePersonality(() => 0.1);
    expect(Object.keys(t).sort()).toEqual(PERSONALITY_AXES.map((a) => a.name).sort());
    for (const a of PERSONALITY_AXES) expect(a.poles).toContain(t[a.name]);
  });
  it('rng < 0.5 picks first pole, >= 0.5 picks second', () => {
    expect(samplePersonality(() => 0.0).verbosity).toBe('terse');
    expect(samplePersonality(() => 0.9).verbosity).toBe('thorough');
  });
});

describe('rngForId (deterministic per-id seeding)', () => {
  it('is deterministic — same id yields the same flavor', () => {
    expect(flavor('ag-1781967946146-y0vq4x')).toBe(flavor('ag-1781967946146-y0vq4x'));
  });
  it('decorrelates across ids — 200 ids hit many distinct flavors', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(flavor('ag-' + i));
    expect(seen.size).toBeGreaterThan(10); // not collapsed to one
  });
  it('the two same-millisecond ids that previously collided now differ', () => {
    expect(flavor('ag-1781967946146-y0vq4x')).not.toBe(flavor('ag-1781967946159-8zkf92'));
  });
});

describe('renderPersonalityBlock', () => {
  it('includes the marker, a heading, and all sampled traits', () => {
    const block = renderPersonalityBlock(samplePersonality(() => 0.9));
    expect(block).toContain('<!-- base-personality -->');
    expect(block).toContain('## Working style');
    expect(block).toContain('**thorough**');
    expect(block).toContain('base-agent-contract');
  });
});

describe('seedPersonality', () => {
  it('appends a style block after existing SOUL.md content (core truths)', () => {
    fs.mkdirSync(path.join(TMP, 'w1'), { recursive: true });
    fs.writeFileSync(soulFile('w1'), '# Soul\n\nYou are a guest with access.\n');
    seedPersonality(group('w1'), () => 0.9);
    const out = fs.readFileSync(soulFile('w1'), 'utf-8');
    expect(out).toContain('guest with access');
    expect(out).toContain('<!-- base-personality -->');
    expect(out.indexOf('guest with access')).toBeLessThan(out.indexOf('base-personality'));
  });

  it('creates SOUL.md when none exists', () => {
    seedPersonality(group('w2'), () => 0.1);
    expect(fs.readFileSync(soulFile('w2'), 'utf-8')).toContain('**terse**');
  });

  it('defaults to id-seeded rng (no ambient randomness)', () => {
    seedPersonality(group('w4', 'ag-deterministic'));
    const out = fs.readFileSync(soulFile('w4'), 'utf-8');
    expect(out).toContain('**' + samplePersonality(rngForId('ag-deterministic')).verbosity + '**');
  });

  it('is idempotent — never re-rolls or double-appends (marker guard)', () => {
    seedPersonality(group('w3'), () => 0.1);
    const first = fs.readFileSync(soulFile('w3'), 'utf-8');
    seedPersonality(group('w3'), () => 0.9);
    const second = fs.readFileSync(soulFile('w3'), 'utf-8');
    expect(second).toBe(first);
    expect(second.split('<!-- base-personality -->').length - 1).toBe(1);
  });
});
