/**
 * Startup heal — reconciles `sessions.container_status` left stale by a
 * SIGTERM'd mid-turn agent (host restart / reboot while a container was
 * alive).
 *
 * The container process dies with the host, but the parent process exits
 * before its `on('close')` handler runs — so `container_status` never gets
 * reset to 'stopped'. Host-sweep already re-wakes turns whose
 * `processing_ack` claim is still 'processing' (killed before the first
 * result). The gap this closes: a turn that got PAST its first result (claim
 * marked 'completed' early while the stream stayed open) is promoted to
 * `messages_in.status='completed'` by `syncProcessingAcks` — so
 * `countDueMessages` reads 0 and host-sweep never re-fires for it. Real case:
 * agent announced "I've started a deep research task…" then was SIGTERM'd
 * mid-research and went dark.
 *
 * Runs once at boot, after the delivery adapter + polls are up (so a resumed
 * agent's reply can actually be delivered) and before host-sweep starts (so
 * its first tick can pick up anything re-pended here). Host-only — never
 * touches processing_ack / messages_in claim semantics, never re-runs
 * completed work.
 */
import type Database from 'better-sqlite3';

import { isContainerRunning, wakeContainer } from './container-runner.js';
import { getProcessingClaims, type ProcessingClaim } from './db/session-db.js';
import { getActiveSessions, getSession } from './db/sessions.js';
import { log } from './log.js';
import { markContainerStopped, openOutboundDb, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

export const RESUME_NUDGE =
  '⚠️ System restart recovery: the service restarted while you may have been mid-task; your prior ' +
  'conversation context is restored. If you had an UNFINISHED task (e.g. an in-progress research or ' +
  'multi-step job), resume and complete it now, then deliver the result. If your previous turn was ' +
  'already fully complete and delivered, no action is needed — ignore this.';

export interface HealDecision {
  resetFlag: boolean;
  injectNudge: boolean;
  wake: boolean;
}

/**
 * Pure decision for whether a boot-time session needs healing. All inputs
 * are deterministic; DB/container reads happen in the caller.
 */
export function decideHeal(input: {
  containerStatus: Session['container_status'];
  isRunning: boolean;
  hasProcessingClaim: boolean;
}): HealDecision {
  if (input.containerStatus !== 'running' || input.isRunning) {
    return { resetFlag: false, injectNudge: false, wake: false };
  }
  if (input.hasProcessingClaim) {
    // host-sweep's crashed-container cleanup already re-wakes unacked turns.
    return { resetFlag: true, injectNudge: false, wake: false };
  }
  // Claim completed (or no claim at all) but the container is gone — the
  // agent may be mid-task with the reply never delivered. Nudge + resume;
  // the agent decides via its restored continuation whether there's
  // anything left to finish.
  return { resetFlag: true, injectNudge: true, wake: true };
}

export interface HealDeps {
  getActiveSessions: () => Session[];
  isContainerRunning: (sessionId: string) => boolean;
  openOutboundDb: (agentGroupId: string, sessionId: string) => Database.Database;
  getProcessingClaims: (outDb: Database.Database) => ProcessingClaim[];
  markContainerStopped: (sessionId: string) => void;
  writeSessionMessage: typeof writeSessionMessage;
  getSession: (id: string) => Session | undefined;
  wakeContainer: (session: Session) => Promise<boolean>;
}

const defaultDeps: HealDeps = {
  getActiveSessions,
  isContainerRunning,
  openOutboundDb,
  getProcessingClaims,
  markContainerStopped,
  writeSessionMessage,
  getSession,
  wakeContainer,
};

/** Best-effort read of outstanding 'processing' claims. Missing/unreadable outbound.db → no claim. */
function hasPendingProcessingClaim(deps: HealDeps, session: Session): boolean {
  let outDb: Database.Database | null = null;
  try {
    outDb = deps.openOutboundDb(session.agent_group_id, session.id);
    return deps.getProcessingClaims(outDb).length > 0;
  } catch {
    return false;
  } finally {
    outDb?.close();
  }
}

function buildNudgeMessage(session: Session) {
  return {
    id: `startup-heal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: RESUME_NUDGE, sender: 'system', senderId: 'system' }),
    onWake: 1 as const,
  };
}

/**
 * Boot-time sweep: reconcile every active session's `container_status`
 * against reality. Never throws — a bad session is logged and skipped so one
 * corrupt row can't abort startup.
 */
export async function reconcileSessionsOnBoot(deps: HealDeps = defaultDeps): Promise<void> {
  const sessions = deps.getActiveSessions();
  let healed = 0;

  for (const session of sessions) {
    try {
      const isRunning = deps.isContainerRunning(session.id);
      // Only pay for the outbound.db read when the fast-path in decideHeal
      // (status != 'running', or actually running) wouldn't already no-op.
      const needsClaimCheck = session.container_status === 'running' && !isRunning;
      const hasClaim = needsClaimCheck ? hasPendingProcessingClaim(deps, session) : false;

      const decision = decideHeal({
        containerStatus: session.container_status,
        isRunning,
        hasProcessingClaim: hasClaim,
      });
      if (!decision.resetFlag) continue;

      deps.markContainerStopped(session.id);
      const actions: string[] = ['reset'];

      if (decision.injectNudge) {
        deps.writeSessionMessage(session.agent_group_id, session.id, buildNudgeMessage(session));
        actions.push('nudge');
      }

      if (decision.wake) {
        const fresh = deps.getSession(session.id);
        if (fresh) await deps.wakeContainer(fresh);
        actions.push('wake');
      }

      healed += 1;
      log.info('Startup heal: reconciled stale session', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        actions,
      });
    } catch (err) {
      log.error('Startup heal: failed to reconcile session, skipping', { sessionId: session.id, err });
    }
  }

  log.info('Startup heal complete', { total: sessions.length, healed });
}
