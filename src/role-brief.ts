/**
 * Role brief — the structured MANDATE for a new hire (qa-report/0002 #7).
 *
 * Pure helpers only:
 *   - validateRoleBrief enforces the template (required reportsTo/mandate/doneWhen
 *     + optional toolLimits/statusExpectation).
 *   - renderRoleBrief produces the markdown block, ending in a precedence line.
 *
 * create_agent renders a valid brief into the new agent[39m\[39ms `instructions`, so it lands
 * ABOVE the sampled working-style block via the normal CLAUDE.local.md seed —
 * provider-agnostic, no direct file writes here.
 */
export interface RoleBrief {
  reportsTo: string;
  mandate: string;
  doneWhen: string;
  toolLimits?: string;
  statusExpectation?: string;
}

const REQUIRED = ['reportsTo', 'mandate', 'doneWhen'] as const;
const OPTIONAL = ['toolLimits', 'statusExpectation'] as const;
export const ROLE_BRIEF_MARKER = '<!-- role-brief -->';

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
    if (!nonEmptyString(input[k])) errors.push('missing or empty required field: ' + k);
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
    ROLE_BRIEF_MARKER,
    '## Role brief',
    '',
    '- **Reports to:** ' + brief.reportsTo,
    '- **Mandate:** ' + brief.mandate,
    '- **Done when:** ' + brief.doneWhen,
  ];
  if (brief.toolLimits) lines.push('- **Tool limits:** ' + brief.toolLimits);
  if (brief.statusExpectation) lines.push('- **Status expectation:** ' + brief.statusExpectation);
  lines.push(
    '',
    'This is your mandate. It — with the SOPs and the safety guardrails in the',
    'base-agent-contract — **overrides** your working style. When in doubt, serve the mandate.',
    '',
  );
  return lines.join('\n');
}
