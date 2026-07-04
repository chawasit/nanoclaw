/**
 * First-run onboarding directive — appended ONCE to a new hire's CLAUDE.local.md.
 *
 * Points every new agent at the workspace SOP before it starts working, and tells
 * it to record a durable `## Onboarding` note in its own memory so "where things
 * live" is learned once, not re-derived every session. The reading list is BOUNDED
 * (not "study everything") to protect cheap-worker budget.
 *
 * Idempotency is two-layered:
 *   - Injection: a marker guard (like personality) so we never double-append.
 *   - Behavior: the agent writes its own `## Onboarding` note when done; the
 *     directive tells it to skip onboarding on later sessions once that note exists.
 *
 * Env-gated on COMPANY_NAS_PATH: the directive references the company-shared NAS
 * mounts (/workspace/extra/{vault,shared}), so it's inert where the NAS isn't
 * configured (prod-without-NAS, the local-LLM test instance) — same gate as the
 * mounts in base-profile. (Private/working files live in the durable group folder
 * at /workspace/agent, which is always mounted regardless of the NAS.)
 *
 * CREATE-ONLY: call from the creation path AFTER initGroupFilesystem (which
 * writes CLAUDE.local.md) + seedPersonality (which now writes
 * /workspace/agent/SOUL.md — see personality.ts / agent-home.ts). Never from
 * the spawn path.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const MARKER = '<!-- base-onboarding -->';

export function renderOnboardingBlock(): string {
  return [
    MARKER,
    '## First-run onboarding (do once)',
    '',
    'Before your first task, **if there is no `## Onboarding` note below this line**:',
    '',
    '1. Read, in order: `/workspace/extra/vault/sop/agent-workspace.md` →',
    '   `base-agent-contract` → `status-reporting` → your **role brief** (top of this',
    '   file). Skim `/workspace/extra/vault/MOC.md` to see what else exists.',
    '2. Learn your workspace: **`/workspace/agent`** is your durable private home —',
    '   keep your working/private files here. **`/workspace/extra/shared`** (RW, all',
    '   agents) is for anything company-accessible. **`/workspace/extra/vault`** is the',
    '   company vault (RO; leaders RW). `ls` them so you know what is there.',
    '3. Append an `## Onboarding` note here capturing: your mandate (1 line), your',
    '   workspace paths, the 3-4 SOPs that matter to your role (1 line each), and the',
    '   hand-off convention (write to `shared/from-<you>/…`, then send an a2a pointer).',
    '',
    'Then begin your mandate. On later sessions this note is already loaded — skip these steps.',
    '',
  ].join('\n');
}

export function seedOnboarding(group: AgentGroup): void {
  // Inert unless the company NAS is configured (the directive references its mounts).
  if (!process.env.COMPANY_NAS_PATH) return;

  const file = path.resolve(GROUPS_DIR, group.folder, 'CLAUDE.local.md');
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    // CLAUDE.local.md not created yet — seed fresh.
  }
  if (existing.includes(MARKER)) return; // already seeded — never double-append

  const prefix = existing.trimEnd().length > 0 ? existing.trimEnd() + '\n\n' : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prefix + renderOnboardingBlock() + '\n');
  log.info('Seeded first-run onboarding directive', { agentGroupId: group.id });
}
