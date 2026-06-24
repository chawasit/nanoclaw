/**
 * a2a_peers — remote A2A-protocol agents the company can send to via the
 * outbound `a2a` transport. A peer is referenced by an `agent_destinations` row
 * with `target_type='a2a', target_id=<peer.id>` (the existing per-agent ACL).
 *
 * Created by migration 020 ('a2a-peers'). Inert until a peer + a matching
 * destination row exist — prod with the table empty behaves identically.
 */
import { getDb } from '../../../db/connection.js';

export interface A2aPeer {
  id: string;
  name: string;
  /** The peer's JSON-RPC endpoint (POST target), e.g. https://peer.example/a2a. */
  endpoint: string;
  /** 'bearer' (static token) is all Phase 2 supports. */
  auth_scheme: string;
  /** The bearer token to present to the peer (nullable for no-auth peers). */
  auth_token: string | null;
  created_at: string;
}

export function getPeer(id: string): A2aPeer | undefined {
  return getDb().prepare('SELECT * FROM a2a_peers WHERE id = ?').get(id) as A2aPeer | undefined;
}

export function listPeers(): A2aPeer[] {
  return getDb().prepare('SELECT * FROM a2a_peers ORDER BY created_at').all() as A2aPeer[];
}

export function createPeer(peer: Omit<A2aPeer, 'created_at'> & { created_at?: string }): void {
  getDb()
    .prepare(
      `INSERT INTO a2a_peers (id, name, endpoint, auth_scheme, auth_token, created_at)
       VALUES (@id, @name, @endpoint, @auth_scheme, @auth_token, @created_at)`,
    )
    .run({
      id: peer.id,
      name: peer.name,
      endpoint: peer.endpoint,
      auth_scheme: peer.auth_scheme ?? 'bearer',
      auth_token: peer.auth_token ?? null,
      created_at: peer.created_at ?? new Date().toISOString(),
    });
}

export function deletePeer(id: string): void {
  getDb().prepare('DELETE FROM a2a_peers WHERE id = ?').run(id);
}
