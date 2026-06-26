import type Database from 'better-sqlite3';

import { hasTable } from '../../db/connection.js';

/** Per-row-class deletion counts from one decommission cascade. */
export interface AgentGroupCascadeCounts {
  sessions: number;
  pending_questions: number;
  pending_approvals: number;
  agent_destinations_owned: number;
  agent_destinations_pointing: number;
  pending_sender_approvals: number;
  pending_channel_approvals: number;
  messaging_group_agents: number;
  agent_message_policies: number;
  agent_group_members: number;
  user_roles: number;
  container_configs: number;
}

/**
 * The authoritative FK-safe decommission cascade for one agent group.
 *
 * Deletes, in FK-safe order, EVERY row class that references `agent_groups(id)`
 * or `sessions(id)` for `groupId`, then the `agent_groups` row itself, in a
 * single better-sqlite3 transaction (so any FK violation rolls the whole thing
 * back and the central DB stays consistent). Returns each DELETE's `changes`
 * count, describing exactly what the transaction did.
 *
 * This is the single row-set authority shared by `ncl groups delete` and the
 * Circle M05 decommission engine (which calls it, then layers tasks.db reassign
 * + `user_roles` offboard on top). It is safe to call inside an outer
 * transaction — better-sqlite3 nests the inner one as a SAVEPOINT.
 *
 * NOTE on `agent_message_policies` (migration 017): both `from_agent_group_id`
 * and `to_agent_group_id` FK-reference `agent_groups(id)`, so BOTH directions
 * must be cleared before the `agent_groups` delete. The old inline cascade
 * missed this entirely — the first decommission of any agent that ever had a
 * message policy threw `SQLITE_CONSTRAINT_FOREIGNKEY` and aborted.
 */
export function cascadeDeleteAgentGroup(db: Database.Database, groupId: string): AgentGroupCascadeCounts {
  const hasAgentDestinations = hasTable(db, 'agent_destinations');
  const hasPendingApprovals = hasTable(db, 'pending_approvals');

  const cascade = db.transaction((id: string): AgentGroupCascadeCounts => {
    const counts: AgentGroupCascadeCounts = {
      sessions: 0,
      pending_questions: 0,
      pending_approvals: 0,
      agent_destinations_owned: 0,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 0,
      pending_channel_approvals: 0,
      messaging_group_agents: 0,
      agent_message_policies: 0,
      agent_group_members: 0,
      user_roles: 0,
      container_configs: 0,
    };

    if (hasAgentDestinations) {
      counts.agent_destinations_owned = db
        .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
        .run(id).changes;
      counts.agent_destinations_pointing = db
        .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
        .run('agent', id).changes;
    }
    // Both legs of the agent-to-agent message-policy edge FK-reference
    // agent_groups(id); clear them in either direction.
    counts.agent_message_policies = db
      .prepare('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?')
      .run(id, id).changes;
    counts.pending_questions = db
      .prepare('DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)')
      .run(id).changes;
    if (hasPendingApprovals) {
      counts.pending_approvals = db
        .prepare(
          'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        )
        .run(id, id).changes;
    }
    counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(id).changes;
    counts.pending_sender_approvals = db
      .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
      .run(id).changes;
    counts.pending_channel_approvals = db
      .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
      .run(id).changes;
    counts.messaging_group_agents = db
      .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
      .run(id).changes;
    counts.agent_group_members = db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(id).changes;
    counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(id).changes;
    // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
    // the explicit delete here mirrors the other tables and surfaces the count.
    counts.container_configs = db.prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(id).changes;
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
    return counts;
  });

  return cascade(groupId);
}
