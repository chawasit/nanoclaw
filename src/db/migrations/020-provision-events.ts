import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Durable sliding-window store for the M08 provision rate-guard.
 *
 * One append-only row per allowed agent provision (`ts`, the creator's
 * `agent_group_id`, the optional SSO-verified `domain`). The guard counts rows
 * inside its window to decide per-creator / global / per-domain rate trips.
 *
 * Why DB-backed (not an in-memory counter like send-dedup): the D27 threat is a
 * compromised SSO account / provisioning loop that could cycle the process to
 * clear an in-memory window. A sqlite table survives restarts, so the window
 * cannot be reset by a restart loop. Old rows beyond the window are pruned
 * opportunistically — bounded growth. `domain` is NULLABLE (non-SSO/exempt
 * callers have none). Index on `ts` powers the windowed range scan + prune.
 */
export const migration020: Migration = {
  version: 20,
  name: 'provision-events',
  up(db: Database.Database) {
    db.prepare(
      'CREATE TABLE IF NOT EXISTS provision_events (ts INTEGER NOT NULL, creator_id TEXT NOT NULL, domain TEXT)',
    ).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_provision_events_ts ON provision_events(ts)').run();
  },
};
