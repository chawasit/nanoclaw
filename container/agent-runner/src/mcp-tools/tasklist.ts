/**
 * Task-list MCP tools: task_create, task_update, report_status, task_list.
 *
 * WRITES (task_create / task_update / report_status): the container can't write
 * to the host's task DB, so these emit a `kind='system'` outbound message with
 * an `action`; the host's tasklist module applies it to data/tasklist/tasks.db
 * (modeled on scheduling). Ownership is attributed host-side from the trusted
 * session identity — the agent's own group id is NOT sent.
 *
 * READS (task_list): the bus is one-way and can't return data mid-turn, so the
 * host's tasks.db is bind-mounted READ-ONLY at /workspace/extra/tasklist and we
 * read it directly with bun:sqlite. Absent the mount, the tool returns a
 * friendly notice instead of throwing (writes still work without the mount).
 */
import { Database } from 'bun:sqlite';

import { loadConfig } from '../config.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const TASKLIST_DB_PATH = '/workspace/extra/tasklist/tasks.db';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function genId(): string {
  return `tsk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Emit a system action over the bus. No routing fields needed — the host
 *  handles system actions before any channel routing. */
function emit(action: string, extra: Record<string, unknown>): void {
  writeMessageOut({
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    content: JSON.stringify({ action, ...extra }),
  });
}

export const taskCreate: McpToolDefinition = {
  tool: {
    name: 'task_create',
    description:
      'Create a task on the shared work board, owned by you. Returns the task id — pass it to task_update later. Use parentTaskId to nest a subtask under an existing task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short description of the task' },
        parentTaskId: { type: 'string', description: 'Optional id of a parent task to nest under' },
      },
      required: ['title'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    if (!title) return err('title is required');
    const id = genId();
    const parentTaskId = (args.parentTaskId as string) || null;
    emit('task_create', { taskId: id, title, parentTaskId });
    log(`task_create: ${id}`);
    return ok(`Task created (id: ${id})`);
  },
};

export const taskUpdate: McpToolDefinition = {
  tool: {
    name: 'task_update',
    description:
      'Update one of your tasks: move its status (todo → doing → done, or blocked) and optionally record why it is blocked. You can only update tasks you own.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Id of the task to update (from task_create / task_list)' },
        status: {
          type: 'string',
          description: 'New status: todo | doing | blocked | done',
          enum: ['todo', 'doing', 'blocked', 'done'],
        },
        blockedReason: {
          type: 'string',
          description: 'Why the task is blocked (set when status = blocked; pass empty string to clear)',
        },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const extra: Record<string, unknown> = { taskId };
    if (typeof args.status === 'string') extra.status = args.status;
    if (typeof args.blockedReason === 'string') extra.blockedReason = args.blockedReason === '' ? null : args.blockedReason;
    if (Object.keys(extra).length === 1) return err('at least one field (status or blockedReason) is required');
    emit('task_update', extra);
    log(`task_update: ${taskId}`);
    return ok(`Task update requested: ${taskId}`);
  },
};

export const reportStatus: McpToolDefinition = {
  tool: {
    name: 'report_status',
    description:
      'Report your current status to the standup board (one latest row per agent). Use this so your manager can see what you are doing without asking. State must be one of working | blocked | idle | done.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: {
          type: 'string',
          description: 'working | blocked | idle | done',
          enum: ['working', 'blocked', 'idle', 'done'],
        },
        summary: { type: 'string', description: 'What you are doing right now' },
        blockers: { type: 'string', description: "What's in your way (if blocked)" },
        eta: { type: 'string', description: 'Free-text estimate, e.g. "~20m" or "EOD"' },
      },
      required: ['state'],
    },
  },
  async handler(args) {
    const state = args.state as string;
    if (!state) return err('state is required');
    const extra: Record<string, unknown> = { state };
    if (typeof args.summary === 'string') extra.summary = args.summary;
    if (typeof args.blockers === 'string') extra.blockers = args.blockers;
    if (typeof args.eta === 'string') extra.eta = args.eta;
    emit('report_status', extra);
    log(`report_status: ${state}`);
    return ok(`Status reported: ${state}`);
  },
};

interface TaskRow {
  id: string;
  agent_group_id: string;
  title: string;
  status: string;
  blocked_reason: string | null;
}
interface StatusRow {
  agent_group_id: string;
  state: string;
  summary: string | null;
  blockers: string | null;
  eta: string | null;
  updated_at: string;
}

export const taskList: McpToolDefinition = {
  tool: {
    name: 'task_list',
    description:
      'Read the shared work board. scope="mine" (default) shows only your tasks; scope="all" shows every agent\'s tasks plus the status board (use this for a standup overview). Optionally filter tasks by status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'mine (default) | all', enum: ['mine', 'all'] },
        status: { type: 'string', description: 'Filter tasks by status: todo | doing | blocked | done' },
      },
    },
  },
  async handler(args) {
    let db: Database;
    try {
      db = new Database(TASKLIST_DB_PATH, { readonly: true });
    } catch (e) {
      return err(`task board not mounted at ${TASKLIST_DB_PATH} (${e instanceof Error ? e.message : String(e)})`);
    }
    try {
      // loadConfig() is idempotent and reads the container.json mounted at an
      // absolute path; the MCP server process never called it (only the
      // poll-loop does), so getConfig() would throw here.
      const mine = loadConfig().agentGroupId;
      const scope = (args.scope as string) || 'mine';
      const status = args.status as string | undefined;

      const where: string[] = [];
      const params: string[] = [];
      if (scope !== 'all') {
        where.push('agent_group_id = ?');
        params.push(mine);
      }
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      const sql =
        'SELECT id, agent_group_id, title, status, blocked_reason FROM tasks' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY created_at ASC';
      const tasks = db.query(sql).all(...params) as TaskRow[];

      const lines: string[] = [];
      if (tasks.length === 0) {
        lines.push('No tasks.');
      } else {
        for (const t of tasks) {
          const who = scope === 'all' ? `${t.agent_group_id} ` : '';
          const blocked = t.status === 'blocked' && t.blocked_reason ? ` (blocked: ${t.blocked_reason})` : '';
          lines.push(`- ${who}${t.id} [${t.status}] ${t.title}${blocked}`);
        }
      }

      if (scope === 'all') {
        const statuses = db
          .query('SELECT agent_group_id, state, summary, blockers, eta, updated_at FROM statuses ORDER BY updated_at DESC')
          .all() as StatusRow[];
        lines.push('', '## Status board');
        if (statuses.length === 0) {
          lines.push('No status reports yet.');
        } else {
          for (const s of statuses) {
            const bits = [s.summary, s.blockers ? `blockers: ${s.blockers}` : '', s.eta ? `eta: ${s.eta}` : '']
              .filter(Boolean)
              .join(' · ');
            lines.push(`- ${s.agent_group_id} [${s.state}] ${bits}`);
          }
        }
      }

      return ok(lines.join('\n'));
    } finally {
      db.close();
    }
  },
};

registerTools([taskCreate, taskUpdate, reportStatus, taskList]);
