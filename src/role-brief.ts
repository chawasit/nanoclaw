/**
 * Role brief — the structured MANDATE seeded into a new hire's CLAUDE.local.md.
 *
 * Two-part identity: the role brief (what the agent is FOR — deliberate, manager-
 * authored) sits ABOVE the sampled working-style block (how it tends to work).
 * The brief, the SOPs, and the safety guardrails always override style
 * (qa-report/0002 #7).
 *
 * Pure `validateRoleBrief` / `renderRoleBrief` + a create-only, marker-guarded
 * `seedRoleBrief` (mirrors personality.ts). Call at creation BEFORE seedPersonality
 * so the mandate lands above the style block.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

export interface RoleBrief {
  reportsTo: string;
  mandate: string;
  doneWhen: string;
  toolLimits?: string;
  statusExpectation?: string;
}

const REQUIRED = ['reportsTo', 'mandate', 'doneWhen'] as const;
const OPTIONAL = ['toolLimits', 'statusExpectation'] as const;
const MARKER = '<!-- role-brief -->';

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateRoleBrief(input: Record<string, unknown>): {
  ok: boolean;
  errors: string[];
  brief?: RoleBrief;
} {
  const errors: string[] = [];
  for (const k of REQUIRED) {
    if (!nonEmptyString(input[k])) errors.push(`missing or empty required field: ${k}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const brief: RoleBrief = {
    reportsTo: (input.reportsTo as string).trim(),
    mandate: (input.mandate as string).trim(),
    doneWhen: (input.doneWhen as string).trim(),
  };
  for (const k of OPTIONAL) {
    if (nonEmptyString(input[k])) brief[k] = (input[k] as string).trim();
  }
  return { ok: true, errors: [], brief };
}

export function renderRoleBrief(brief: RoleBrief): string {
  const lines = [
    MARKER,
    '## Role brief',
    '',
    `- **Reports to:** ${brief.reportsTo}`,
    `- **Mandate:** ${brief.mandate}`,
    `- **Done when:** ${brief.doneWhen}`,
  ];
  if (brief.toolLimits) lines.push(`- **Tool limits:** ${brief.toolLimits}`);
  if (brief.statusExpectation) lines.push(`- **Status expectation:** ${brief.statusExpectation}`);
  lines.push(
    '',
    'This is your mandate. It — together with the SOPs and the safety guardrails in the',
    'base-agent-contract — **overrides** your working style. When in doubt, serve the mandate.',
    '',
  );
  return lines.join('\n');
}

export function seedRoleBrief(group: AgentGroup, brief: RoleBrief): void {
  const file = path.resolve(GROUPS_DIR, group.folder, 'CLAUDE.local.md');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    // CLAUDE.local.md not created yet — seed fresh.
  }
  if (existing.includes(MARKER)) return; // create-only — never re-render

  const prefix = existing.trimEnd().length > 0 ? existing.trimEnd() + '\n\n' : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prefix + renderRoleBrief(brief) + '\n');
  log.info('Seeded role brief', { agentGroupId: group.id, reportsTo: brief.reportsTo });
}
