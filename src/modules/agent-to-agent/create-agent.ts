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
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
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
import { countChildren, createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

/**
 * Recruiting headcount caps (Path A, slice 1; plan §5.4 "Controls").
 *
 * Hard structural anti-runaway brakes on the AUTONOMOUS create path —
 * `create_agent`, both the trusted global-CoS direct route and the confined
 * route after approval — so a buggy self-recruiting loop or a prompt-injected
 * agent can't fan out unbounded ("Paperclip slop"). Distinct from the authz
 * gate (which only decides direct-create vs approval): caps bound the company's
 * SIZE and a single manager's FAN-OUT regardless of who is trusted.
 *
 * SCOPE: this guards the agent-initiated path. The other two creators are
 * human-gated and intentionally exempt — `channel-approval.createNewAgentGroup`
 * (a person approves each channel wiring) and the `ncl groups create` CLI.
 * Neither is an autonomous-runaway vector; see the note on createNewAgentGroup.
 *
 * Configurable via env (generous defaults). FAIL-OPEN + log: this is the
 * load-bearing create path, so a counting bug must never brick hiring.
 * NOTE: depth cap is a separate later slice (needs an ancestor walk).
 */
const DEFAULT_MAX_AGENTS = 25;
const DEFAULT_MAX_DIRECT_REPORTS = 10;

/** Parse a positive-integer env cap; fall back to the default on unset/0/NaN. */
function envCap(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Returns a human-readable rejection reason if a hard recruiting cap is hit,
 * else null. Counts are best-effort: any failure fails OPEN (allow + log) so a
 * query bug can't stop the company from hiring.
 */
function recruitingCapViolation(creatorId: string): string | null {
  try {
    const maxAgents = envCap('NANOCLAW_MAX_AGENTS', DEFAULT_MAX_AGENTS);
    const total = getAllAgentGroups().length;
    if (total >= maxAgents) {
      return `company headcount cap reached (${total}/${maxAgents}). Decommission an agent or ask the owner to raise NANOCLAW_MAX_AGENTS.`;
    }
    const maxReports = envCap('NANOCLAW_MAX_DIRECT_REPORTS', DEFAULT_MAX_DIRECT_REPORTS);
    const reports = countChildren(creatorId);
    if (reports >= maxReports) {
      return `direct-report cap reached (${reports}/${maxReports}) for this manager. Delegate via a sub-manager or ask the owner to raise NANOCLAW_MAX_DIRECT_REPORTS.`;
    }
    return null;
  } catch (err) {
    log.error('recruiting cap check failed — allowing create (fail-open)', { err, creatorId });
    return null;
  }
}

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

  // Early cap check: don't bother an admin with an approval for a hire that the
  // authoritative check in performCreateAgent would reject anyway. (That check
  // is the real enforcement — the confined path reaches creation via
  // applyCreateAgent → performCreateAgent, NOT back through here.)
  const earlyCapMsg = recruitingCapViolation(sourceGroup.id);
  if (earlyCapMsg) {
    notifyAgent(session, `create_agent denied: ${earlyCapMsg}`);
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
 */
async function performCreateAgent(
  name: string,
  instructions: string | null,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
): Promise<void> {
  // AUTHORITATIVE recruiting cap check — the chokepoint BOTH paths share
  // (global-scope direct create AND confined create-after-approval). The
  // early check in handleCreateAgent is only UX; this one actually enforces
  // (e.g. several "under-cap-at-request" hires approved over time).
  const capMsg = recruitingCapViolation(sourceGroup.id);
  if (capMsg) {
    notify(`create_agent denied: ${capMsg}`);
    log.warn('create_agent blocked by recruiting cap', { creator: sourceGroup.id, name, reason: capMsg });
    return;
  }

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
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
    return;
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

  notify(`Agent "${localName}" created. You can now message it with send_message({ to: "${localName}", text: "…" }).`);
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
}
