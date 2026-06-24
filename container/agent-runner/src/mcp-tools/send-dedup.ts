/**
 * Container-side send idempotency.
 *
 * The synchronous half of the two-part send-dedup fix. The host
 * (`src/send-dedup.ts` + delivery.ts) is the durable backstop that guarantees
 * an identical PDF is delivered at most once. THIS module produces the
 * synchronous tool-result signal the agent actually reads, so a retry-happy
 * model (glm-5.2 re-issued one morning-digest `send_file` 10x) is told
 * "already sent" on its 2nd call and stops.
 *
 * It queries the agent's OWN outbound.db for a recent row with byte-identical
 * `(channel_type, platform_id, content)` within the window. The MCP tool runs
 * in-process with the outbound writer, so this read sees rows the same agent
 * just wrote this turn.
 *
 * The WINDOW + KEY (channel_type, platform_id, content; thread_id excluded)
 * MUST match the host side in `src/send-dedup.ts`. They are separate processes;
 * keep them in sync by hand.
 */
import { getOutboundDb } from '../db/connection.js';

/** Override with NANOCLAW_SEND_DEDUP_WINDOW_MS (0 disables). Mirrors src/send-dedup.ts. */
export const SEND_DEDUP_WINDOW_MS = ((): number => {
  const raw = process.env.NANOCLAW_SEND_DEDUP_WINDOW_MS;
  if (raw === undefined || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

/**
 * Find a recent outbound row with identical content to the same destination,
 * written within the dedup window. Used PRE-write: the burst's earlier rows
 * already exist, so the 2nd..Nth identical `send_*` call sees the 1st.
 *
 * Returns the matching row's seq (to cite in the tool result) or null.
 */
export function findRecentIdenticalSend(args: {
  channelType: string;
  platformId: string;
  content: string;
  windowMs?: number;
}): { seq: number | null } | null {
  const windowMs = args.windowMs ?? SEND_DEDUP_WINDOW_MS;
  if (windowMs <= 0) return null;
  // messages_out.timestamp is datetime('now') (UTC, second resolution). Compare
  // against the cutoff in SQLite so we don't depend on JS parsing the stored
  // string. windowSec rounds UP so a sub-second window still matches same-second
  // rows (the rapid burst lands in the same wall-clock second).
  const windowSec = Math.ceil(windowMs / 1000);
  const row = getOutboundDb()
    .prepare(
      `SELECT seq FROM messages_out
        WHERE channel_type = ?
          AND platform_id = ?
          AND content = ?
          AND timestamp >= datetime('now', '-' || ? || ' seconds')
        ORDER BY timestamp DESC, seq DESC
        LIMIT 1`,
    )
    .get(args.channelType, args.platformId, args.content, windowSec) as { seq: number | null } | undefined;
  return row ?? null;
}
