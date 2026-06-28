import { appendFileSync, statSync } from 'node:fs';

/**
 * Cross-process tally of user-facing message DELIVERIES the agent makes via the
 * send tools (send_message / send_file). The poll loop snapshots this at each
 * turn's start and re-checks it at the turn's `result` event to decide whether
 * the agent actually delivered anything — and, if not, to nudge it to call
 * send_message instead of leaving its reply as undelivered scratchpad.
 *
 * The tally MUST live on the filesystem, not in a module variable: the send
 * tools (recordDelivery) run in the nanoclaw MCP server, which the runner spawns
 * as a SEPARATE stdio subprocess (`bun run mcp-tools/index.ts` — see index.ts /
 * mcp-tools/server.ts), while the poll loop reads deliveryCount() in the main
 * agent-runner process. Those are two distinct heaps, so a module-level `let`
 * incremented in the subprocess is forever 0 from the poll loop — which made the
 * undelivered-reply nudge false-fire after every real send_message. A shared
 * file bridges the boundary.
 *
 * Counts ONLY genuine first-class deliveries: send_message and send_file
 * (including a dedup-skip — an identical recent send means the content WAS
 * delivered, so it must count or the nudge would fight the idempotency guard).
 * It deliberately does NOT count edit_message / add_reaction (acknowledgements
 * on existing messages, which also write kind='chat') or any kind='system'
 * tool (report_status, task_*, schedule_task, create_agent…) — so a turn that
 * only reacts / edits / reports-status and otherwise leaves its reply unwrapped
 * is still correctly detected as undelivered. Counting at the delivery SOURCE
 * is correct-by-construction: no outbound-row content inspection, no
 * JSON-escaping edge cases, no false positives from other kind='chat' writers.
 *
 * The count is the tally file's size in bytes — one byte appended per delivery.
 * On Linux a single-byte O_APPEND write is atomic, so concurrent appends from
 * the subprocess never corrupt the count and there is no read-modify-write race.
 * The value is monotonic within a container and only ever compared as deltas
 * (turn-start baseline vs. turn-end), so absolute magnitude and per-container
 * resets are both fine; /tmp is container-ephemeral, so each spawn starts clean.
 */

/**
 * Resolve the tally file path on every call (never cached) so a test can point
 * an isolated temp file via NANOCLAW_DELIVERY_TALLY, and so the spawned MCP
 * subprocess and the poll-loop process agree on the same file. Defaults to the
 * container-ephemeral /tmp path when the env override is absent.
 */
function tallyPath(): string {
  return process.env.NANOCLAW_DELIVERY_TALLY || '/tmp/nanoclaw-deliveries.tally';
}

/** Record one delivery (send_message / send_file). Called from the send tools. */
export function recordDelivery(): void {
  appendFileSync(tallyPath(), '\0');
}

/**
 * Monotonic count of deliveries since the tally was last reset (container spawn).
 * Compare deltas between two reads (turn start vs. turn end), never absolute
 * values. Returns 0 when the tally file does not exist yet (no deliveries).
 */
export function deliveryCount(): number {
  try {
    return statSync(tallyPath()).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}
