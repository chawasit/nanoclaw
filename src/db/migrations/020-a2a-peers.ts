import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * A2A peers: remote A2A-protocol agents this company can send to via the
 * outbound `a2a` transport (company/services/a2a-adapter is the inbound server;
 * this is the outbound client side).
 *
 * Purely ADDITIVE: a new TABLE only. It does NOT touch `agent_destinations` —
 * the outbound transport reuses that table's existing free-text `target_type`
 * column with a new value `'a2a'` (no DDL change; row exists ⇒ authorized, same
 * ACL model as `'channel'`/`'agent'`). A peer is referenced by `agent_destinations`
 * rows as `target_type='a2a', target_id=<peer id>`.
 *
 * Inert until an operator inserts a peer + a matching `a2a` destination — prod
 * with the table empty behaves identically (the delivery `channel_type==='a2a'`
 * branch never fires without a destination row).
 *
 * The migration runner keys uniqueness on `name` (version is an ordering hint);
 * 'a2a-peers' is a fresh name and version 20 is the next free number after 019.
 */
export const migration020: Migration = {
  version: 20,
  name: 'a2a-peers',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE a2a_peers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        endpoint    TEXT NOT NULL,
        auth_scheme TEXT NOT NULL DEFAULT 'bearer',
        auth_token  TEXT,
        created_at  TEXT NOT NULL
      );
    `);
  },
};
