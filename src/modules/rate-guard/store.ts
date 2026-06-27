/**
 * M08 rate-guard — the durable window store (better-sqlite3 helpers around the
 * `provision_events` table, migration 020).
 *
 * Pure-ish: the `db` handle is passed in (no global singleton), so these are
 * unit-testable against an in-memory DB. Column<->field mapping: the table
 * stores `creator_id`; the planner consumes `creatorId` (RateEvent). The window
 * boundary here matches the planner exactly (`ts > now - windowMs`, exclusive).
 */
import type Database from 'better-sqlite3';
import type { RateEvent } from './evaluate.js';

interface ProvisionRow {
  ts: number;
  creator_id: string;
  domain: string | null;
}

/** Append one provision event (call AFTER an allowed create commits). */
export function recordProvisionEvent(
  db: Database.Database,
  ev: { ts: number; creatorId: string; domain?: string | null },
): void {
  db.prepare('INSERT INTO provision_events (ts, creator_id, domain) VALUES (?, ?, ?)').run(
    ev.ts,
    ev.creatorId,
    ev.domain ?? null,
  );
}

/**
 * Events inside the window, oldest-first, mapped to the planner's RateEvent
 * shape. Exclusive lower bound (`ts > now - windowMs`) — identical to the
 * planner so the two agree on what "in the window" means.
 */
export function recentProvisionEvents(db: Database.Database, now: number, windowMs: number): RateEvent[] {
  const rows = db
    .prepare('SELECT ts, creator_id, domain FROM provision_events WHERE ts > ? ORDER BY ts')
    .all(now - windowMs) as ProvisionRow[];
  return rows.map((r) => ({ ts: r.ts, creatorId: r.creator_id, domain: r.domain }));
}

/**
 * Delete events aged out beyond `keepMs` (opportunistic prune to bound growth).
 * Inclusive (`ts <= now - keepMs`) so a row exactly on the keep boundary — no
 * longer countable by the exclusive window — is reclaimed. Returns the number
 * of rows deleted.
 */
export function pruneProvisionEvents(db: Database.Database, now: number, keepMs: number): number {
  return db.prepare('DELETE FROM provision_events WHERE ts <= ?').run(now - keepMs).changes;
}
