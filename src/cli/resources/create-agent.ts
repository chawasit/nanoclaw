/**
 * `ncl create_agent` — Circle M12 admin control-plane: create an agent under an
 * arbitrary parent. Mirrors `provision.ts`'s shape (host-only gate, fail-closed
 * refusals via a discriminated result, `performCreateAgent` as the shared body)
 * but is driven by an admin-chosen parent instead of the fixed main agent, and
 * has no principal binding / web-lane / model-env wiring — Circle's admin UI
 * supplies an optional `model` column write only.
 *
 * HOST-ONLY. Same 0600 `ncl.sock` boundary as provision; the handler additionally
 * hard-rejects any non-host caller so no confined OR global agent can reach it.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { performCreateAgent } from '../../modules/agent-to-agent/create-agent.js';
import { renderRoleBrief, validateRoleBrief, type RoleBrief } from '../../role-brief.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

export interface CreateAgentArgs {
  parentAgentGroupId: string;
  name: string;
  /**
   * Either the structured spine RoleBrief (rendered via `renderRoleBrief`) or a
   * plain free-text brief (Circle's admin form sends a string) used verbatim as
   * the new agent's instructions.
   */
  roleBrief?: RoleBrief | string;
  model?: string;
}

export type CreateAgentRefusal = 'not-host' | 'parent_not_found' | 'parent_not_active' | 'create_failed';

export type CreateAgentResult = { ok: true; agentGroupId: string } | { ok: false; error: CreateAgentRefusal };

export function parseCreateAgentArgs(raw: Record<string, unknown>): CreateAgentArgs {
  const parentAgentGroupId = typeof raw.parentAgentGroupId === 'string' ? raw.parentAgentGroupId.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!parentAgentGroupId) throw new Error('parentAgentGroupId is required');
  if (!name) throw new Error('name is required');

  let roleBrief: RoleBrief | string | undefined;
  if (raw.roleBrief != null) {
    if (typeof raw.roleBrief === 'string') {
      // Circle's admin form sends a free-text brief — used verbatim as instructions.
      roleBrief = raw.roleBrief.trim() || undefined;
    } else if (typeof raw.roleBrief === 'object') {
      const v = validateRoleBrief(raw.roleBrief as Record<string, unknown>);
      if (!v.ok) throw new Error('invalid roleBrief — ' + v.errors.join('; '));
      roleBrief = v.brief;
    } else {
      throw new Error('roleBrief must be a string or a RoleBrief object');
    }
  }

  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined;
  return { parentAgentGroupId, name, roleBrief, model };
}

export async function createAgent(args: CreateAgentArgs, ctx: CallerContext): Promise<CreateAgentResult> {
  // HARD host-only gate — privileged control-plane write.
  if (ctx.caller !== 'host') {
    log.warn('create_agent rejected: non-host caller', { caller: ctx.caller });
    return { ok: false, error: 'not-host' };
  }

  const parentGroup = getAgentGroup(args.parentAgentGroupId);
  if (!parentGroup) {
    log.error('create_agent: parent agent group not found', { parentAgentGroupId: args.parentAgentGroupId });
    return { ok: false, error: 'parent_not_found' };
  }

  // performCreateAgent projects the new child destination into the PARENT's
  // running session inbound.db (writeDestinations), so the parent needs an
  // active session. KNOWN RISK: an idle parent can't accept the projection —
  // fail closed with a clear refusal rather than let writeDestinations throw
  // on a missing session. The admin can retry once the parent wakes.
  const parentSession = findSessionByAgentGroup(args.parentAgentGroupId);
  if (!parentSession) {
    log.error('create_agent: parent agent has no active session', { parentAgentGroupId: args.parentAgentGroupId });
    return { ok: false, error: 'parent_not_active' };
  }

  const instructions =
    typeof args.roleBrief === 'string' ? args.roleBrief : args.roleBrief ? renderRoleBrief(args.roleBrief) : null;
  const created = await performCreateAgent(args.name, instructions, parentSession, parentGroup, (text) =>
    log.info('create_agent notice', { text }),
  );
  if (!created) {
    log.error('create_agent: performCreateAgent returned null', { name: args.name, parentAgentGroupId: args.parentAgentGroupId });
    return { ok: false, error: 'create_failed' };
  }

  if (args.model) {
    updateContainerConfigScalars(created.id, { model: args.model });
  }

  log.info('create_agent: agent created under admin-chosen parent', {
    agentGroupId: created.id,
    parentAgentGroupId: args.parentAgentGroupId,
    model: args.model ?? null,
  });
  return { ok: true, agentGroupId: created.id };
}

register<CreateAgentArgs, CreateAgentResult>({
  name: 'create_agent',
  description:
    'Circle M12: admin control-plane create an agent under an arbitrary parent. Host-only. Args: --parentAgentGroupId --name [--roleBrief] [--model].',
  access: 'open', // host-only is enforced in the handler (the ncl.sock 0600 boundary + the caller check)
  parseArgs: parseCreateAgentArgs,
  handler: createAgent,
});
