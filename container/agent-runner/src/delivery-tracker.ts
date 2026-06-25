/**
 * In-process tally of user-facing message DELIVERIES the agent makes via the
 * send tools (send_message / send_file). The poll loop snapshots this at each
 * turn's start and re-checks it at the turn's `result` event to decide whether
 * the agent actually delivered anything — and, if not, to nudge it to call
 * send_message instead of leaving its reply as undelivered scratchpad.
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
 * Module-level state is safe for the same reason as current-batch.ts — the
 * agent-runner is single-process and processes one batch at a time, and the
 * in-process MCP server runs the send tools on the same heap as the poll loop.
 */
let deliveries = 0;

/** Record one delivery (send_message / send_file). Called from the send tools. */
export function recordDelivery(): void {
  deliveries += 1;
}

/**
 * Monotonic count of deliveries since process start. Compare deltas between two
 * reads (turn start vs. turn end), never absolute values.
 */
export function deliveryCount(): number {
  return deliveries;
}
