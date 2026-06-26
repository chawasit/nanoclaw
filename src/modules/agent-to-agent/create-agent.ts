/**
 * `create_agent` delivery-action handler.
 *
 * SECURITY: `create_agent` writes to the CENTRAL DB (agent_groups,
 * container_configs, agent_destinations) and scaffolds host filesystem state —
 * a privileged operation a confined container is otherwise architecturally
 * barred from. The container's MCP tool gate is inside the (untrusted)
 * container and is trivially bypassed by writing the outbound system row
 * directly, so authorization MUST be enforced host-side. Trusted owner agent
 * groups (CLI scope 'global') create directly; every other (confined) group
 * requires admin approval via `requestApproval` — matching `ncl groups create`
 * (access: 'approval') and the self-mod actions. `applyCreateAgent` runs the
 * creation on approve; `performCreateAgent` is the shared body.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { applyBaseProfile } from '../../base-profile.js';
import { seedPersonality } from '../../personality.js';
import { seedOnboarding } from '../../onboarding.js';
import { renderRoleBrief, validateRoleBrief } from '../../role-brief.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { requestApproval, type ApprovalHandler } from '../approvals/index.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

/**
 * Optional Circle-provisioning extras for {@link performCreateAgent}. Dormant on
 * the existing autonomous create paths (both callers omit it); supplied only by
 * the future Circle SSO-provisioning chain (M03/M08) that needs the new id and a
 * principal binding back. `principalUserId`, when given, binds that human
 * principal to the new agent group via `agent_group_members` (the same table
 * M22/M03 use for owner↔CoS); `domain` is recorded for audit/log context only.
 */
export interface PerformCreateAgentOptions {
  principalUserId?: string;
  domain?: string;
}

/**
 * Org-size / fan-out caps REMOVED (M08 cap-removal half, owner-approved
 * 2026-06-27). The dev-log/0034 brakes (`NANOCLAW_MAX_AGENTS=25`,
 * `NANOCLAW_MAX_DIRECT_REPORTS=10`) were anti-runaway limits on the autonomous
 * create path, but under the multi-user platform agent creation is gated by
 * Google SSO (a human hire per agent, D10), so an org-size ceiling now blocks
 * legitimate growth — under the flat topology (D30, every employee a direct
 * report of the one main agent) the 10-direct-report cap was a hard 10-employee
 * company ceiling M03 auto-provision would hit at the 11th hire. The env vars
 * are now inert. The runaway threat (a compromised SSO account / provisioning
 * loop spawning thousands fast) is handled by M08's rate-guard — a fast-follow,
 * NOT this slice. See SPEC-M08; tracked as the M08 rate-guard remainder.
 */

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Delivery-action entry.
 *
 * Authorization depends on the calling group's CLI scope:
 *   - `global` (set by init-first-agent for trusted owner agent groups):
 *     create immediately. create_agent is the intended primitive for these
 *     privileged agents, and an approval tap on every sub-agent spawn would be
 *     needless friction.
 *   - anything else (the default `group` scope — the realistic
 *     prompt-injection victim): require an admin to approve before any
 *     central-DB write. `applyCreateAgent` runs on approve.
 * Unknown/missing config fails closed to the approval path.
 */
export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  let instructions = typeof content.instructions === 'string' ? content.instructions : null;
  // Optional structured role brief (qa-report/0002 #7): validate, then render it into
  // `instructions` so the mandate lands ABOVE the working-style block via the normal seed.
  if (content.roleBrief != null) {
    if (typeof content.roleBrief !== 'object') {
      notifyAgent(session, 'create_agent failed: roleBrief must be an object.');
      return;
    }
    const v = validateRoleBrief(content.roleBrief as Record<string, unknown>);
    if (!v.ok) {
      notifyAgent(session, 'create_agent failed: invalid roleBrief — ' + v.errors.join('; '));
      return;
    }
    instructions = renderRoleBrief(v.brief!) + (instructions ?? '');
  }

  if (!name) {
    notifyAgent(session, 'create_agent failed: name is required.');
    return;
  }

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  const cliScope = getContainerConfig(session.agent_group_id)?.cli_scope ?? 'group';
  if (cliScope === 'global') {
    // Trusted owner agent group — create directly, then notify (+wake) it.
    await performCreateAgent(name, instructions, session, sourceGroup, (text) => notifyAgent(session, text));
    return;
  }

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: { name, instructions },
    title: `Create agent: ${name}`,
    question: `Agent "${sourceGroup.name}" wants to create a new sub-agent "${name}" (a new agent group with its own workspace and container). Approve?`,
  });
}

/**
 * Approval handler: performs the creation once an admin approves a request from
 * a confined (non-global) agent group. `session` is the requesting parent.
 */
export const applyCreateAgent: ApprovalHandler = async ({ session, payload, notify }) => {
  const name = typeof payload.name === 'string' ? payload.name : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions : null;

  if (!name) {
    notify('create_agent approved but the request had no name.');
    return;
  }

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notify('create_agent approved but the source agent group no longer exists.');
    log.warn('create_agent apply failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  await performCreateAgent(name, instructions, session, sourceGroup, notify);
};

/**
 * Core creation: writes the new agent group + bidirectional destinations and
 * scaffolds its filesystem, then reports via `notify`. Authorization is the
 * CALLER's responsibility (the global-scope shortcut in handleCreateAgent or
 * admin approval via applyCreateAgent) — never call this from an unauthorized
 * path, as it performs privileged central-DB writes a confined container is
 * otherwise barred from.
 *
 * Returns the newly-created {@link AgentGroup} (incl. its minted id) on success,
 * or `null` if a guard (recruiting cap, name collision, path traversal) declined
 * the create — those paths already `notify()` the caller. Existing call sites
 * ignore the return and are unaffected; Circle provisioning consumes the id.
 */
export async function performCreateAgent(
  name: string,
  instructions: string | null,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
  options: PerformCreateAgentOptions = {},
): Promise<AgentGroup | null> {
  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return null;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notify(`Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return null;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  // A subagent inherits its creator's provider. Provider is a DB property; the
  // child is created provider-agnostic, then stamped with the parent's runtime
  // so a single-provider install (e.g. codex-only, where claude isn't
  // authenticated) doesn't spawn a child on a runtime it can't reach. The
  // operator can still flip a child later with `ncl groups config update
  // --provider`. claude (the built-in default) leaves the column unset.
  const parentProvider = getContainerConfig(sourceGroup.id)?.provider ?? undefined;
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: parentProvider });
  // Base agent profile (search/scrape MCP + task board) — create-only.
  applyBaseProfile(newGroup.id);
  seedPersonality(newGroup);
  seedOnboarding(newGroup);
  if (parentProvider) {
    updateContainerConfigScalars(newGroup.id, { provider: parentProvider });
  }

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  // Circle provisioning (dormant on the autonomous paths): bind the supplied
  // human principal to the new agent group. Same membership table M22/M03 use;
  // caller owns ensuring the `users` row exists (FK).
  if (options.principalUserId) {
    addMember({ user_id: options.principalUserId, agent_group_id: agentGroupId, added_by: null, added_at: now });
  }

  notify(`Agent "${localName}" created. You can now message it with send_message({ to: "${localName}", text: "…" }).`);
  log.info('Agent group created', {
    agentGroupId,
    name,
    localName,
    folder,
    parent: sourceGroup.id,
    principal: options.principalUserId ?? null,
    domain: options.domain ?? null,
  });
  return newGroup;
}
