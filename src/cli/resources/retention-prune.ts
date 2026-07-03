/**
 * `ncl retention_prune` — Circle M21 scheduled spine-host retention prune
 * (`docs/m21-retention-erasure-blueprint.md` "Merger's decisions" #1, workstream
 * (d), the LAST M21 workstream). Unlike `erase_user` (one principal, on demand),
 * this is a periodic AGE-based sweep with no per-user targeting — the spine has
 * no visibility into Circle-Postgres's `offboard_denylist`, so it can't compute
 * an offboard-epoch cutoff; every class here prunes by age-of-record instead.
 *
 * HOST-ONLY. Same 0600 `ncl.sock` boundary as create_agent/erase_user.
 *
 * Classes (independently selectable via `--classes`, default = all):
 *   - `chat`    — `messages_in`/`messages_out` rows older than the window, across
 *                 EVERY session (system-wide, not per-agent).
 *   - `tasks`   — `tasks.db` rows with status='done' whose `updated_at` is older
 *                 than the window. Never touches todo/doing/blocked — pruning an
 *                 in-flight task is data loss, not retention hygiene.
 *   - `archive` — D35 decommission-archive dirs (`groups/<any>/archive/
 *                 <folder>__<sub>__<epochMs>/`) whose epoch is older than the
 *                 window. Covers both spec class 3 (files/workspace, which is
 *                 already an archive by the time this runs) and class 7 (the
 *                 archive itself) — there's one live mechanism for both.
 *
 * Windows are `RETENTION_PRUNE_{CHAT,TASKS,ARCHIVE}_DAYS` (conservative defaults
 * below), matching Circle's `CIRCLE_RETENTION_*` env-overridable pattern — no
 * code change to retune. `dryRun` counts only, mutates nothing.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { openInboundDb, openOutboundDbRw } from '../../db/session-db.js';
import { log } from '../../log.js';
import { TASKLIST_DB_PATH } from '../../modules/tasklist/db.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

export type RetentionPruneClass = 'chat' | 'tasks' | 'archive';
const ALL_CLASSES: RetentionPruneClass[] = ['chat', 'tasks', 'archive'];

const DAY_MS = 24 * 60 * 60 * 1000;

function windowDays(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const chatWindowDays = (): number => windowDays('RETENTION_PRUNE_CHAT_DAYS', 365);
const tasksWindowDays = (): number => windowDays('RETENTION_PRUNE_TASKS_DAYS', 365);
const archiveWindowDays = (): number => windowDays('RETENTION_PRUNE_ARCHIVE_DAYS', 90);

export interface RetentionPruneArgs {
  /** Omit to run every class. */
  classes?: RetentionPruneClass[];
  dryRun: boolean;
}

export type RetentionPruneRefusal = 'not-host';

export type RetentionPruneResult =
  | { ok: true; perClass: Record<string, { pruned: number }> }
  | { ok: false; error: RetentionPruneRefusal };

export function parseRetentionPruneArgs(raw: Record<string, unknown>): RetentionPruneArgs {
  const dryRun = raw.dryRun === true;
  if (raw.classes == null) return { dryRun };

  if (!Array.isArray(raw.classes)) throw new Error('classes must be an array of strings');
  const invalid = raw.classes.filter((c) => !ALL_CLASSES.includes(c as RetentionPruneClass));
  if (invalid.length > 0) throw new Error(`invalid retention class(es): ${invalid.join(', ')}`);
  return { classes: raw.classes as RetentionPruneClass[], dryRun };
}

/** DELETE FROM <table> WHERE timestamp < ?, or a COUNT(*) preview under dryRun. */
function pruneSessionTableByAge(
  dbPath: string,
  table: 'messages_in' | 'messages_out',
  cutoffIso: string,
  dryRun: boolean,
  open: (p: string) => Database.Database,
): number {
  const db = open(dbPath);
  try {
    if (dryRun) {
      return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE timestamp < ?`).get(cutoffIso) as { c: number }).c;
    }
    return db.prepare(`DELETE FROM ${table} WHERE timestamp < ?`).run(cutoffIso).changes;
  } finally {
    db.close();
  }
}

/** Every `messages_in`/`messages_out` row older than the window, across ALL sessions. */
function pruneChatByAge(dryRun: boolean): number {
  const base = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(base)) return 0;
  const cutoffIso = new Date(Date.now() - chatWindowDays() * DAY_MS).toISOString();

  let pruned = 0;
  for (const agentGroupId of fs.readdirSync(base)) {
    const agentDir = path.join(base, agentGroupId);
    if (!fs.statSync(agentDir).isDirectory()) continue;

    for (const entry of fs.readdirSync(agentDir)) {
      const sessionDir = path.join(agentDir, entry);
      if (!fs.statSync(sessionDir).isDirectory()) continue; // skips .claude-shared etc.

      const inboundPath = path.join(sessionDir, 'inbound.db');
      if (fs.existsSync(inboundPath)) {
        pruned += pruneSessionTableByAge(inboundPath, 'messages_in', cutoffIso, dryRun, openInboundDb);
      }
      const outboundPath = path.join(sessionDir, 'outbound.db');
      if (fs.existsSync(outboundPath)) {
        pruned += pruneSessionTableByAge(outboundPath, 'messages_out', cutoffIso, dryRun, openOutboundDbRw);
      }
    }
  }
  return pruned;
}

/** `status='done'` rows whose `updated_at` is older than the window. Never touches open work. */
function pruneTasksByAge(dryRun: boolean): number {
  if (!fs.existsSync(TASKLIST_DB_PATH)) return 0;
  const cutoffIso = new Date(Date.now() - tasksWindowDays() * DAY_MS).toISOString();

  const db = new Database(TASKLIST_DB_PATH);
  db.pragma('journal_mode = DELETE');
  try {
    if (dryRun) {
      return (
        db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'done' AND updated_at < ?`).get(cutoffIso) as {
          c: number;
        }
      ).c;
    }
    return db.prepare(`DELETE FROM tasks WHERE status = 'done' AND updated_at < ?`).run(cutoffIso).changes;
  } finally {
    db.close();
  }
}

/** The epoch-ms suffix of a `<folder>__<sub>__<epochMs>` archive dirname, or null if it doesn't match. */
function parseArchiveEpochMs(dirName: string): number | null {
  const match = /__(\d+)$/.exec(dirName);
  if (!match) return null;
  const epochMs = Number(match[1]);
  return Number.isFinite(epochMs) ? epochMs : null;
}

/** D35 archive dirs (`groups/<any>/archive/<folder>__<sub>__<epochMs>/`) past their window. */
function pruneArchivesByAge(dryRun: boolean): number {
  if (!fs.existsSync(GROUPS_DIR)) return 0;
  const cutoffMs = Date.now() - archiveWindowDays() * DAY_MS;

  let pruned = 0;
  for (const groupFolder of fs.readdirSync(GROUPS_DIR)) {
    const archiveDir = path.join(GROUPS_DIR, groupFolder, 'archive');
    if (!fs.existsSync(archiveDir)) continue;

    for (const entry of fs.readdirSync(archiveDir)) {
      const epochMs = parseArchiveEpochMs(entry);
      if (epochMs === null || epochMs > cutoffMs) continue;
      pruned += 1;
      if (!dryRun) fs.rmSync(path.join(archiveDir, entry), { recursive: true, force: true });
    }
  }
  return pruned;
}

export async function retentionPrune(args: RetentionPruneArgs, ctx: CallerContext): Promise<RetentionPruneResult> {
  // HARD host-only gate — privileged, destructive control-plane write.
  if (ctx.caller !== 'host') {
    log.warn('retention_prune rejected: non-host caller', { caller: ctx.caller });
    return { ok: false, error: 'not-host' };
  }

  const classes = args.classes ?? ALL_CLASSES;
  const perClass: Record<string, { pruned: number }> = {};

  if (classes.includes('chat')) perClass.chat = { pruned: pruneChatByAge(args.dryRun) };
  if (classes.includes('tasks')) perClass.tasks = { pruned: pruneTasksByAge(args.dryRun) };
  if (classes.includes('archive')) perClass.archive = { pruned: pruneArchivesByAge(args.dryRun) };

  log.info('retention_prune: run complete', { classes, dryRun: args.dryRun, perClass });
  return { ok: true, perClass };
}

register<RetentionPruneArgs, RetentionPruneResult>({
  name: 'retention_prune',
  description:
    'Circle M21: scheduled spine-host retention prune (age-based chat/tasks/archive, no per-user targeting). ' +
    'Host-only. Args: [--classes chat,tasks,archive] [--dryRun].',
  access: 'open', // host-only is enforced in the handler (the ncl.sock 0600 boundary + the caller check)
  parseArgs: parseRetentionPruneArgs,
  handler: retentionPrune,
});
