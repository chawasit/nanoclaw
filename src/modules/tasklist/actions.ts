/**
 * Delivery-action handlers for the task-list module.
 *
 * The container can't write to the host's task DB. When an agent calls
 * task_create / task_update / report_status via MCP, the container writes a
 * `kind='system'` outbound message carrying an `action`; the delivery path
 * dispatches here (registered in ./index.ts) and we apply the change to the
 * standalone `data/tasklist/tasks.db`.
 *
 * Handlers match the DeliveryActionHandler shape `(content, session, inDb)`.
 * We ignore `inDb` (the per-session inbound.db) and write to the tasklist DB
 * instead. Ownership is ALWAYS taken from `session.agent_group_id` — the
 * host-trusted identity — never from agent-supplied fields.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getTasklistDb, insertTask, updateTask, upsertStatus, type TaskPatch } from './db.js';

export async function handleTaskCreate(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const agentGroupId = session.agent_group_id;
  const id = content.taskId as string;
  const title = content.title as string;
  const parentTaskId = (content.parentTaskId as string) ?? null;
  if (!id || !title) {
    log.warn('task_create missing id/title', { agentGroupId, id });
    return;
  }
  try {
    insertTask(getTasklistDb(), { id, agentGroupId, title, parentTaskId });
    log.info('Task created', { id, agentGroupId, parentTaskId });
  } catch (err) {
    log.warn('task_create rejected', { id, agentGroupId, err });
  }
}

export async function handleTaskUpdate(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const agentGroupId = session.agent_group_id;
  const id = content.taskId as string;
  if (!id) {
    log.warn('task_update missing id', { agentGroupId });
    return;
  }
  const patch: TaskPatch = {};
  if (typeof content.status === 'string') patch.status = content.status;
  if (content.blockedReason === null || typeof content.blockedReason === 'string') {
    patch.blockedReason = content.blockedReason as string | null;
  }
  try {
    const touched = updateTask(getTasklistDb(), id, agentGroupId, patch);
    log.info('Task updated', { id, agentGroupId, touched, fields: Object.keys(patch) });
  } catch (err) {
    log.warn('task_update rejected', { id, agentGroupId, err });
  }
}

export async function handleReportStatus(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const agentGroupId = session.agent_group_id;
  const state = content.state as string;
  if (!state) {
    log.warn('report_status missing state', { agentGroupId });
    return;
  }
  const summary = typeof content.summary === 'string' ? content.summary : null;
  const blockers = typeof content.blockers === 'string' ? content.blockers : null;
  const eta = typeof content.eta === 'string' ? content.eta : null;
  try {
    upsertStatus(getTasklistDb(), { agentGroupId, state, summary, blockers, eta });
    log.info('Status reported', { agentGroupId, state });
  } catch (err) {
    log.warn('report_status rejected', { agentGroupId, state, err });
  }
}
