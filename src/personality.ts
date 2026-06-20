/**
 * Agent personality — a per-hire *working-style* seed applied ONCE at creation.
 *
 * Two-part identity (see SOP agent-personality.md):
 *   - MANDATE (role, team, reporting chain, success criteria) → deliberate, set by
 *     the hiring manager via create_agent `instructions` (seeded into CLAUDE.local.md
 *     by initGroupFilesystem). NOT randomized.
 *   - WORKING STYLE (temperament) → sampled here from a CURATED palette for healthy
 *     team diversity (anti-monoculture). One pole per axis from vetted options.
 *
 * The sample is seeded DETERMINISTICALLY from the agent group id (rngForId), not
 * ambient Math.random: that makes style uncorrelated across hires (each id is
 * unique), reproducible/auditable, and immune to V8 per-context seeding quirks
 * (two agents created in the same millisecond right after a restart otherwise
 * drew identical Math.random sequences).
 *
 * HARD RULE: style varies; values, mandate, reporting chain, and safety guardrails
 * never do — those live in the role brief + base-agent-contract SOP and always win.
 *
 * CREATE-ONLY: call from the creation path AFTER initGroupFilesystem (which writes
 * CLAUDE.local.md). Idempotent via a marker guard — never re-rolls or double-appends.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

export interface PersonalityAxis {
  name: string;
  poles: [string, string];
}

/** Curated style axes. Each hire samples one pole per axis (2^5 = 32 coherent flavors). */
export const PERSONALITY_AXES: PersonalityAxis[] = [
  { name: 'verbosity', poles: ['terse', 'thorough'] },
  { name: 'risk', poles: ['cautious', 'bold'] },
  { name: 'mode', poles: ['skeptical/critical', 'synthesizing/building'] },
  { name: 'focus', poles: ['detail-first', 'big-picture'] },
  { name: 'pace', poles: ['deliberate', 'fast-iterating'] },
];

const MARKER = '<!-- base-personality -->';

/** FNV-1a 32-bit string hash → 32-bit seed. */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG — small, fast, well-distributed; deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic RNG bound to an agent id. */
export function rngForId(id: string): () => number {
  return mulberry32(hashSeed(id));
}

export function samplePersonality(rng: () => number): Record<string, string> {
  const traits: Record<string, string> = {};
  for (const axis of PERSONALITY_AXES) {
    traits[axis.name] = axis.poles[rng() < 0.5 ? 0 : 1];
  }
  return traits;
}

export function renderPersonalityBlock(traits: Record<string, string>): string {
  const list = PERSONALITY_AXES.map((a) => traits[a.name]).filter(Boolean);
  return [
    MARKER,
    '## Working style',
    '',
    `Your default temperament leans **${list.join('**, **')}**.`,
    '',
    'This is *flavor* — how you tend to communicate and work, for healthy team',
    'diversity. It never overrides your mandate, your reporting chain, the company',
    'values, or the safety guardrails in the base-agent-contract SOP. Those always win.',
    '',
  ].join('\n');
}

export function seedPersonality(group: AgentGroup, rng: () => number = rngForId(group.id)): void {
  const file = path.resolve(GROUPS_DIR, group.folder, 'CLAUDE.local.md');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    // CLAUDE.local.md not created yet (e.g. a surfaces-owning provider) — seed fresh.
  }
  if (existing.includes(MARKER)) return; // already seeded — never re-roll

  const traits = samplePersonality(rng);
  const prefix = existing.trimEnd().length > 0 ? existing.trimEnd() + '\n\n' : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prefix + renderPersonalityBlock(traits) + '\n');
  log.info('Seeded agent personality', { agentGroupId: group.id, traits });
}
