import { getAllDestinations } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { getSessionRouting, type SessionRouting } from './db/session-routing.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import { deliveryCount } from './delivery-tracker.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * The sleep-orchestrator's end-of-day completion marker (mirrors the literal in
 * services/sleep-orchestrator/core.js `COMPLETION_MARKER`). A turn that emits it
 * is the agent signalling it finished its EOD summary — an intentional,
 * delivery-free completion — so it must be exempt from the undelivered-reply nudge.
 */
const SLEEP_SUMMARY_COMPLETE_MARKER = '[[SLEEP_SUMMARY_COMPLETE]]';

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);
    // The session's REAL reply lane, written once by the host at spawn
    // (session_routing WHERE id=1). This is the canonical outbound target for
    // EVERY host-side write below — NOT the inbound-derived `routing`, whose
    // channel_type/platform_id are NULL on the Circle ingress path (the host
    // writes Circle inbound rows with null routing by design). A null-stamped
    // outbound row is filtered out by Circle's origin-lane WS tailer and never
    // reaches the PWA. For channel-originated sessions sessionRouting == the
    // inbound routing, so behaviour there is unchanged. `routing.inReplyTo`
    // (the inbound message id) is still the correct reply-linkage handle.
    const sessionRouting = getSessionRouting();

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: sessionRouting.platform_id,
          channel_type: sessionRouting.channel_type,
          thread_id: sessionRouting.thread_id,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: sessionRouting.platform_id,
          channel_type: sessionRouting.channel_type,
          thread_id: sessionRouting.thread_id,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
      );
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong. Stamp the
      // session's reply lane (not the NULL-on-Circle inbound routing) so the
      // notice actually reaches the user.
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: sessionRouting.platform_id,
        channel_type: sessionRouting.channel_type,
        thread_id: sessionRouting.thread_id,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  // The session's REAL reply lane (host-written session_routing WHERE id=1),
  // fixed for the session. This — NOT the inbound-derived `routing` — is the
  // source of truth for user-lane classification and for every host-side
  // outbound write in this function. On the Circle ingress path the inbound
  // rows carry channel_type=NULL/platform_id=NULL by design, so the old
  // `routing.channelType`-based classification misread the live user lane as
  // non-user (dropping the reply + firing a stale nudge), and a NULL-stamped
  // auto-deliver row was filtered out by Circle's origin-lane WS tailer. For a
  // channel-originated session sessionRouting == the inbound routing, so
  // behaviour there is unchanged. This mirrors what the send_message MCP tool
  // already uses (mcp-tools/core.ts resolveRouting → getSessionRouting), which
  // is why normal send_message replies reach Circle but the auto-deliver did not.
  const sessionRouting: SessionRouting = getSessionRouting();
  // Delivery-aware turn tracking (send_message-only protocol, dev-log/0083).
  // The ONLY way a reply reaches a destination is the send_message / send_file
  // tool; result-text <message> wrappers are no longer dispatched. We snapshot
  // the in-process delivery counter at each turn's start and re-check it at the
  // turn's `result` event: if the agent delivered nothing yet produced visible
  // text, that text is undelivered scratchpad and we nudge it to call the tool.
  let deliveriesBaseline = deliveryCount();
  // Nudge latch that RE-ARMS on every delivery (dev-log/0189, supersedes the old
  // stream-scoped `deliveredThisStream` from dev-log/0135). The prior design
  // suppressed the nudge for the WHOLE rest of an open query once anything was
  // delivered — which on a flaky local model (gemma-4 as the live CoS) produced a
  // real false NEGATIVE: the agent delivers an early reply, then on a LATER
  // follow-up answers in plain text and never calls send_message, and no nudge
  // ever fires because the stream already saw a delivery. So a whole reply is left
  // undelivered and the user's chat goes dark (owner-reported 2026-07-05, verified
  // in the live CoS transcript). We now track per TURN (`deliveredThisTurn`) and
  // only latch the nudge until the NEXT delivery re-arms it — so a
  // delivered-then-stopped agent is caught again, while a genuinely-idle
  // never-delivering turn is still nudged at most once (the latch holds until a
  // delivery clears it). Accepted trade-off (the dev-log/0135 false POSITIVE
  // returns, bounded): a trailing text-only "Done" right after a real send can
  // nudge once — the non-coercive nudge wording (dev-log/0134: "if you already
  // sent it, this is a false alarm, do NOT re-send, just end your turn") absorbs
  // it. MAX_NUDGES_PER_STREAM is a hard backstop against any nudge<->retext loop
  // feeding the OOM (code-137) seen with gemma.
  let nudgedSinceLastDelivery = false;
  let nudgeCount = 0;
  const MAX_NUDGES_PER_STREAM = 5;
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        // A genuine new inbound re-arms the nudge (like a delivery does) so the
        // fresh turn it starts can be caught if it goes undelivered.
        nudgedSinceLastDelivery = false;
        query.push(prompt);
        archivePrompts.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // Did the agent deliver anything this turn? The only delivery path is
        // the send_message / send_file tool (tracked in-process). Visible text
        // that isn't <internal> scratchpad, with no delivery, means the agent
        // left its reply undelivered — nudge it to use the tool.
        const deliveredThisTurn = deliveryCount() > deliveriesBaseline;
        // A delivery this turn RE-ARMS the nudge: the agent proved it can still
        // reach the send tool, so a later dry turn on the same stream should be
        // caught again (see the latch rationale above).
        if (deliveredThisTurn) nudgedSinceLastDelivery = false;
        const scratchpad = event.text ? stripInternalTags(event.text).trim() : '';
        // The sleep-orchestrator end-of-day completion marker is an INTENTIONAL
        // delivery-free turn (the agent consolidates memory + writes handoff.md,
        // no send_message) — so a turn that emits it must NOT be nudged.
        const sleepSummaryComplete = event.text?.includes(SLEEP_SUMMARY_COMPLETE_MARKER) ?? false;
        // Per-TURN undelivered: this turn produced visible (non-<internal>) text
        // and did not itself deliver. The stream-wide suppression is gone; the
        // nudge is instead gated by the re-arming latch + the per-stream cap below.
        const undelivered = !deliveredThisTurn && scratchpad.length > 0 && !sleepSummaryComplete;
        // Relaxed delivery: a turn on the single USER lane (a channel is present and
        // it is NOT the 'agent' peer lane) that produced visible text but called no
        // send tool is auto-relayed to the user below — a plain reply needs no
        // send_message. Peer-directed ('agent') undelivered turns are NOT auto-
        // relayed; they still nudge. A null channel (no session routing) is treated
        // as non-user, so it keeps the existing nudge path. Classified from the
        // SESSION lane (sessionRouting), not the inbound routing — Circle's inbound
        // rows are NULL-channel, which the old check misread as non-user.
        const isUserLane = sessionRouting.channel_type != null && sessionRouting.channel_type !== 'agent';

        if (!deliveredThisTurn && event.isError === true && event.text) {
          // Non-retryable error turn (e.g. a 403 billing_error) that delivered
          // nothing: surface the notice to the triggering channel instead of
          // dropping it as scratchpad, and do NOT nudge — re-prompting would
          // just re-hammer the failing gateway turn after turn.
          deliverErrorResult(event.text, sessionRouting, routing.inReplyTo);
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? initialPrompt,
            result: event.text,
            continuation: queryContinuation ?? initialContinuation,
            status: 'error',
          });
          archivePrompts.shift();
        } else if (undelivered && isUserLane) {
          // Relaxed delivery: a plain assistant reply on the single user lane is
          // delivered automatically — the agent no longer needs send_message for a
          // normal user reply. Mirror deliverErrorResult's host-facing write (one
          // synthetic user-directed row = the internal-stripped scratchpad), mark
          // the exchange 'completed' so notifyExchangeComplete fires (as the error
          // path does), and shift the archived prompt. Deliberately do NOT call
          // recordDelivery(): this is a host write, and leaving the delivery tally
          // untouched keeps the peer-nudge accounting clean. No nudge here.
          log('Turn produced user-lane text with no send call — auto-delivering to the channel (relaxed delivery)');
          writeMessageOut({
            id: generateId(),
            in_reply_to: routing.inReplyTo,
            kind: 'chat',
            platform_id: sessionRouting.platform_id,
            channel_type: sessionRouting.channel_type,
            thread_id: sessionRouting.thread_id,
            content: JSON.stringify({ text: scratchpad }),
          });
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? initialPrompt,
            result: event.text ?? '',
            continuation: queryContinuation ?? initialContinuation,
            status: 'completed',
          });
          archivePrompts.shift();
        } else {
          // Reached only for non-error, non-auto-delivered turns: a peer-directed
          // ('agent'/null-lane) undelivered turn (which nudges), or a delivered /
          // empty / sleep-summary turn (which does not). `!isUserLane` is defensive
          // — an undelivered user-lane turn was already handled above.
          const willNudge =
            undelivered && !isUserLane && !nudgedSinceLastDelivery && nudgeCount < MAX_NUDGES_PER_STREAM;
          if (undelivered) {
            const why = willNudge
              ? ' — nudging'
              : nudgeCount >= MAX_NUDGES_PER_STREAM
                ? ' — nudge cap reached this stream'
                : ' — already nudged since last delivery';
            log(
              `WARNING: turn produced text but nothing was delivered (no send_message/send_file call)` +
                why,
            );
          }
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? initialPrompt,
            result: event.text ?? '',
            continuation: queryContinuation ?? initialContinuation,
            status: undelivered ? 'undelivered' : 'completed',
          });
          if (willNudge) {
            nudgedSinceLastDelivery = true;
            nudgeCount += 1;
            query.push(buildSendNudge(scratchpad));
          }
          // A nudge re-asks the SAME user prompt — keep it queued so the retry
          // archives against it, not the nudge text.
          if (!willNudge) archivePrompts.shift();
        }
        // Re-baseline for the next turn on this still-open stream: a follow-up
        // push starts a fresh turn whose deliveries must count from here, and a
        // post-nudge re-send is detected as a delivery against this baseline.
        deliveriesBaseline = deliveryCount();
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) and
 * the agent delivered nothing via the send tools: the notice would otherwise be
 * dropped as scratchpad. This is the same user-facing write the outer catch
 * block does, minus the `Error:` prefix — the provider's text is already a
 * user-facing message.
 */
function deliverErrorResult(text: string, sessionRouting: SessionRouting, inReplyTo: string | null): void {
  log('Error result with no delivery — delivering provider notice to channel');
  writeMessageOut({
    id: generateId(),
    in_reply_to: inReplyTo,
    kind: 'chat',
    platform_id: sessionRouting.platform_id,
    channel_type: sessionRouting.channel_type,
    thread_id: sessionRouting.thread_id,
    content: JSON.stringify({ text }),
  });
}

/**
 * Heuristic: does this text look like a BOTCHED attempt to send a message —
 * a `<message>`-tag-ish token that did NOT form the canonical
 * `<message to="name">...</message>` envelope? Catches the live failure where
 * glm emitted `<messaggio a="telegram">...</message>` (garbled tag name + wrong
 * `a=` attribute, valid close), plus unquoted/unclosed openers (`<message to=x>`,
 * `<message to="x"` …) and stray `</message>` closes. Intended to run on the text
 * OUTSIDE any successfully-parsed block, so a well-formed block dropped for another
 * reason (reasoning-leak / unknown destination) does NOT trip it. Text passed in
 * should already be internal-stripped so `<message>` examples an agent narrates to
 * itself inside `<internal>` don't count.
 */
export function looksLikeMalformedMessageAttempt(text: string): boolean {
  return /<\s*\/?\s*messag\w*\b|<\s*\/?\s*msg\b/i.test(text);
}

/**
 * Build the "nothing was delivered" nudge (send_message-only protocol). A turn
 * that produced visible text but called no send tool left its reply
 * undelivered. If the leftover scratchpad looks like the agent TRIED to deliver
 * via the retired `<message to=…>` wrapper (or a garbled variant), point that
 * out specifically — otherwise the agent re-emits the same wrapper and loops.
 * Otherwise give the generic send_message nudge. `scratchpad` is already
 * internal-stripped by the caller.
 */
function buildSendNudge(scratchpad: string): string {
  const names = getAllDestinations()
    .map((d) => d.name)
    .join(', ');
  const looksLikeWrapper = /<message\s+to=/i.test(scratchpad) || looksLikeMalformedMessageAttempt(scratchpad);
  if (looksLikeWrapper) {
    return (
      `<nanoclaw_reminders>Heads up: your last turn produced text but nothing was delivered — and it looks like you wrote a ` +
      `<message to="…"> tag, which is no longer a delivery channel (plain text and <message> tags are scratchpad only). ` +
      `If you meant to send that, deliver it now: send_message({ to: "name", text: "…" }) (send_file for files). Your destinations: ${names}. ` +
      `If you already delivered it another way, or there is nothing to send, this reminder is a false alarm — do NOT re-send; just end your turn.</nanoclaw_reminders>`
    );
  }
  return (
    `<nanoclaw_reminders>Heads up: your last turn produced text but nothing was delivered — no send_message/send_file call was recorded. ` +
    `If that text was a reply you still owe someone, deliver it now: send_message({ to: "name", text: "…" }) (send_file for files). Your destinations: ${names}. ` +
    `But if you ALREADY sent it, or that text was just an internal note or acknowledgment with nothing to deliver, this reminder is a false alarm — ` +
    `do NOT re-send; simply end your turn.</nanoclaw_reminders>`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
