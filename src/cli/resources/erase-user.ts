/**
 * `ncl erase_user` — Circle M21 spine residue purge for the right-to-erasure flow
 * (`docs/m21-retention-erasure-blueprint.md` "Spine erase_user handler"). Mirrors
 * `create-agent.ts`'s shape (host-only gate, fail-closed refusal, flat `{ok,…}`
 * result the Circle `SpineCommandClient` reads straight off `res.data` — see
 * `apps/circle-backend/src/retention/erase.ts`, the ground-truth consumer).
 *
 * HOST-ONLY. Same 0600 `ncl.sock` boundary as create_agent/provision; the handler
 * additionally hard-rejects any non-host caller.
 *
 * Deletes/purges every spine-host trace of one principal:
 *   - `user_roles` + `agent_group_members` rows for the principal, GLOBALLY
 *     (class 10/11 backstop — a departed user may have left rows in groups
 *     other than their own bound agent).
 *   - IF `agentGroupId` resolves to a live agent group (the principal's own
 *     M03-provisioned agent): every session's chat content (class 1), the
 *     `CLAUDE.local.md` memory tombstone (class 2), the whole workspace dir
 *     (class 3), and this agent's `tasks.db` rows (class 4).
 *   - Any D35 decommission-archive dir carrying this principal's raw sub in its
 *     name (class 7) — searched under every group's `archive/` regardless of
 *     which agent is "main", since that convention has no live producer yet
 *     (M05 doesn't archive on offboard in this fork) — this is forward-safe
 *     idempotent cleanup for whenever it does.
 *
 * `dryRun` counts every row/file that WOULD be purged and mutates nothing. A
 * missing agent group / folder / session / archive is NOT an error — it's
 * idempotent zeros (an already-erased or never-provisioned subject).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { openInboundDb, openOutboundDbRw } from '../../db/session-db.js';
import { log } from '../../log.js';
import { TASKLIST_DB_PATH } from '../../modules/tasklist/db.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

export interface EraseUserArgs {
  /** Raw Google sub — used ONLY to find the D35 archive dir (its dirname convention). */
  googleSub: string;
  /** Namespaced principal (`google:<sub>`) — the key form `user_roles`/`agent_group_members` use. */
  principal: string;
  /** The subject's own bound agent group, or null when unresolved/never-provisioned. */
  agentGroupId: string | null;
  /** Accepted for parity with the Circle-side call — the spine purge is unconditional (no offboard-epoch gate). */
  beforeWindow: boolean;
  /** Preview-only: count everything that would be purged, mutate nothing. */
  dryRun: boolean;
}

export type EraseUserRefusal = 'not-host';

/** Mirrors `RequestErasureDeps`'s `SpinePurged` in `apps/circle-backend/src/retention/erase.ts`. */
export interface EraseUserPurged {
  chat: number;
  memory: 0 | 1;
  files: number;
  tasks: number;
  archive: 0 | 1;
  userRoles: number;
  agentGroupMembers: number;
}

export type EraseUserResult = { ok: true; purged: EraseUserPurged } | { ok: false; error: EraseUserRefusal };

export function parseEraseUserArgs(raw: Record<string, unknown>): EraseUserArgs {
  const googleSub = typeof raw.googleSub === 'string' ? raw.googleSub.trim() : '';
  const principal = typeof raw.principal === 'string' ? raw.principal.trim() : '';
  if (!googleSub) throw new Error('googleSub is required');
  if (!principal) throw new Error('principal is required');
  const agentGroupId = typeof raw.agentGroupId === 'string' && raw.agentGroupId.trim() ? raw.agentGroupId.trim() : null;
  return {
    googleSub,
    principal,
    agentGroupId,
    beforeWindow: raw.beforeWindow === true,
    dryRun: raw.dryRun === true,
  };
}

/** DELETE FROM <table> WHERE user_id = ?, or a COUNT(*) preview under dryRun. */
function purgeByUserId(table: 'user_roles' | 'agent_group_members', userId: string, dryRun: boolean): number {
  const db = getDb();
  if (dryRun) {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(userId) as { c: number }).c;
  }
  return db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId).changes;
}

/** Every `messages_in` + `messages_out` row across all of this agent's sessions. */
function purgeChatContent(agentGroupId: string, dryRun: boolean): number {
  const agentSessionsDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
  if (!fs.existsSync(agentSessionsDir)) return 0;

  let purged = 0;
  for (const entry of fs.readdirSync(agentSessionsDir)) {
    const sessionDir = path.join(agentSessionsDir, entry);
    if (!fs.statSync(sessionDir).isDirectory()) continue; // skips .claude-shared etc.

    const inboundPath = path.join(sessionDir, 'inbound.db');
    if (fs.existsSync(inboundPath)) purged += purgeSessionTable(inboundPath, 'messages_in', dryRun, openInboundDb);

    const outboundPath = path.join(sessionDir, 'outbound.db');
    if (fs.existsSync(outboundPath))
      purged += purgeSessionTable(outboundPath, 'messages_out', dryRun, openOutboundDbRw);
  }
  return purged;
}

function purgeSessionTable(
  dbPath: string,
  table: 'messages_in' | 'messages_out',
  dryRun: boolean,
  open: (p: string) => Database.Database,
): number {
  const db = open(dbPath);
  try {
    if (dryRun) return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    return db.prepare(`DELETE FROM ${table}`).run().changes;
  } finally {
    db.close();
  }
}

/** Blank the memory surface (rather than delete it — the file itself is about to be rm'd with the workspace). */
function tombstoneMemory(folder: string, dryRun: boolean): 0 | 1 {
  const file = path.join(GROUPS_DIR, folder, 'CLAUDE.local.md');
  if (!fs.existsSync(file)) return 0;
  if (!dryRun) fs.writeFileSync(file, '');
  return 1;
}

/** Recursively count files under `dir` (directories themselves aren't counted). */
function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    count += entry.isDirectory() ? countFiles(full) : 1;
  }
  return count;
}

/** rm the whole `groups/<folder>/` workspace. Returns the file count purged (0 if already gone). */
function purgeWorkspace(folder: string, dryRun: boolean): number {
  const dir = path.join(GROUPS_DIR, folder);
  const count = countFiles(dir);
  if (!dryRun && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return count;
}

/**
 * Any `groups/<any>/archive/<folder>__<sub>__<epochMs>/` dir carrying this sub —
 * scanned under every group (the D35 "which folder is main" convention has no
 * live producer yet, so this can't target one specific archive parent).
 */
function purgeArchive(googleSub: string, dryRun: boolean): 0 | 1 {
  if (!fs.existsSync(GROUPS_DIR)) return 0;
  const marker = `__${googleSub}__`;
  let found = false;
  for (const groupFolder of fs.readdirSync(GROUPS_DIR)) {
    const archiveDir = path.join(GROUPS_DIR, groupFolder, 'archive');
    if (!fs.existsSync(archiveDir)) continue;
    for (const entry of fs.readdirSync(archiveDir)) {
      if (!entry.includes(marker)) continue;
      found = true;
      if (!dryRun) fs.rmSync(path.join(archiveDir, entry), { recursive: true, force: true });
    }
  }
  return found ? 1 : 0;
}

/** DELETE FROM tasks (+ statuses) WHERE agent_group_id = ?, or a COUNT(*) preview under dryRun. */
function purgeTasks(agentGroupId: string, dryRun: boolean): number {
  if (!fs.existsSync(TASKLIST_DB_PATH)) return 0;
  const db = new Database(TASKLIST_DB_PATH);
  db.pragma('journal_mode = DELETE');
  try {
    if (dryRun) {
      return (db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE agent_group_id = ?').get(agentGroupId) as { c: number })
        .c;
    }
    const purge = db.transaction((id: string): number => {
      const changes = db.prepare('DELETE FROM tasks WHERE agent_group_id = ?').run(id).changes;
      db.prepare('DELETE FROM statuses WHERE agent_group_id = ?').run(id);
      return changes;
    });
    return purge(agentGroupId);
  } finally {
    db.close();
  }
}

export async function eraseUser(args: EraseUserArgs, ctx: CallerContext): Promise<EraseUserResult> {
  // HARD host-only gate — privileged, destructive control-plane write.
  if (ctx.caller !== 'host') {
    log.warn('erase_user rejected: non-host caller', { caller: ctx.caller });
    return { ok: false, error: 'not-host' };
  }

  const { dryRun } = args;
  const userRoles = purgeByUserId('user_roles', args.principal, dryRun);
  const agentGroupMembers = purgeByUserId('agent_group_members', args.principal, dryRun);

  let chat = 0;
  let memory: 0 | 1 = 0;
  let files = 0;
  let tasks = 0;

  if (args.agentGroupId) {
    const group = getAgentGroup(args.agentGroupId);
    if (!group) {
      log.warn('erase_user: agentGroupId not found — idempotent zeros for the agent-owned classes', {
        agentGroupId: args.agentGroupId,
      });
    } else {
      chat = purgeChatContent(args.agentGroupId, dryRun);
      memory = tombstoneMemory(group.folder, dryRun);
      files = purgeWorkspace(group.folder, dryRun);
      tasks = purgeTasks(args.agentGroupId, dryRun);
    }
  }

  const archive = purgeArchive(args.googleSub, dryRun);

  log.info('erase_user: purge complete', {
    principal: args.principal,
    agentGroupId: args.agentGroupId,
    dryRun,
    purged: { chat, memory, files, tasks, archive, userRoles, agentGroupMembers },
  });

  return { ok: true, purged: { chat, memory, files, tasks, archive, userRoles, agentGroupMembers } };
}

register<EraseUserArgs, EraseUserResult>({
  name: 'erase_user',
  description:
    'Circle M21: purge every spine-host trace of one principal (right-to-erasure). Host-only. ' +
    'Args: --googleSub --principal [--agentGroupId] [--beforeWindow] [--dryRun].',
  access: 'open', // host-only is enforced in the handler (the ncl.sock 0600 boundary + the caller check)
  parseArgs: parseEraseUserArgs,
  handler: eraseUser,
});
