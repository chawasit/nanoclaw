/**
 * Send idempotency - content-keyed duplicate suppression.
 *
 * Orthogonal to the per-message-id dedup already in delivery.ts (the
 * `delivered` table + `inflightDeliveries`). Those key on `message_out_id`
 * and stop the SAME row being delivered twice (the active/sweep poll race).
 *
 * This module keys on CONTENT instead: it stops N *distinct* outbound rows
 * that carry identical content to the same destination from each delivering,
 * within a short window. That is the observed CoS bug - glm-5.2 re-issued
 * `send_file` 10x for one morning-digest PDF (10 distinct ids/seqs, identical
 * `{"text":"","files":[...]}`), and all 10 delivered to the owner's Telegram.
 *
 * The dedup KEY and WINDOW are shared (by value) with the container-side
 * MCP tool (`container/agent-runner/src/mcp-tools/core.ts`), which surfaces
 * the synchronous "skipped - already sent" signal back to the agent. The two
 * run in separate processes, so the key shape + window must be kept in sync
 * by hand. Host = durable backstop (catches dups from any source);
 * container = the sync tool-result signal that actually stops the retry.
 */
import { createHash } from 'crypto';

/**
 * Duplicate-suppression window. A second identical (channel, platform, content)
 * send within this many milliseconds of a delivered one is dropped.
 * Conservative + short so legitimate re-sends (>window apart) always pass.
 *
 * Override with NANOCLAW_SEND_DEDUP_WINDOW_MS (0 disables the host-side drop).
 * MUST be kept in sync with the container-side window in core.ts.
 */
export const SEND_DEDUP_WINDOW_MS = ((): number => {
  const raw = process.env.NANOCLAW_SEND_DEDUP_WINDOW_MS;
  if (raw === undefined || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

/**
 * Stable content hash for dedup. Hashes the RAW content string (the JSON
 * payload as written to messages_out) so two sends are "identical" iff their
 * serialized content is byte-identical - conservative, exact-match only.
 */
export function hashSendContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Dedup key = (channel_type, platform_id, hash(content)).
 *
 * thread_id is intentionally EXCLUDED per the spec - a digest re-sent to the
 * same chat is a dup regardless of thread bookkeeping.
 */
export function sendDedupKey(channelType: string, platformId: string, content: string): string {
  // Newline-delimited: none of channel_type, platform_id, or a hex hash can
  // contain a newline, so the key is unambiguous (platform_id may contain ':').
  return [channelType, platformId, hashSendContent(content)].join('\n');
}

/**
 * In-memory recent-delivery cache. Maps dedup key -> last-delivered epoch ms.
 * Lost on process restart - that is fine: the durable `delivered` table still
 * filters by message_out_id, and the window is only ~60s, so a restart at most
 * re-opens the window for one burst. Kept tiny via opportunistic pruning.
 */
const recentDeliveries = new Map<string, number>();

/**
 * Decide whether a send is a duplicate of one delivered within the window.
 * Pure read - does NOT record. Call `recordSend` AFTER a successful deliver so
 * a failed first attempt never poisons the key (the retry must be allowed).
 *
 * @param now injectable clock (ms) for tests; defaults to Date.now().
 */
export function isDuplicateSend(
  channelType: string,
  platformId: string,
  content: string,
  now: number = Date.now(),
  windowMs: number = SEND_DEDUP_WINDOW_MS,
): boolean {
  if (windowMs <= 0) return false;
  const key = sendDedupKey(channelType, platformId, content);
  const last = recentDeliveries.get(key);
  return last !== undefined && now - last < windowMs;
}

/** Record a successful delivery for dedup. Call AFTER deliver() resolves. */
export function recordSend(channelType: string, platformId: string, content: string, now: number = Date.now()): void {
  const key = sendDedupKey(channelType, platformId, content);
  recentDeliveries.set(key, now);
  pruneRecentDeliveries(now);
}

/** Drop entries older than 2x the window so the map cannot grow unbounded. */
function pruneRecentDeliveries(now: number, windowMs: number = SEND_DEDUP_WINDOW_MS): void {
  const cutoff = now - windowMs * 2;
  for (const [key, ts] of recentDeliveries) {
    if (ts < cutoff) recentDeliveries.delete(key);
  }
}

/** Test seam - clear the cache between tests. */
export function _resetSendDedup(): void {
  recentDeliveries.clear();
}
