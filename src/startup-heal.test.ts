/**
 * Unit tests for the startup-heal decision + reconcile loop.
 * Mirrors host-sweep.test.ts: pure-decision truth table, then integration
 * tests against fakes + real in-memory better-sqlite3 outbound DBs.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { getProcessingClaims } from './db/session-db.js';
import { decideHeal, reconcileSessionsOnBoot, RESUME_NUDGE, type HealDeps } from './startup-heal.js';
import type { Session } from './types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeOutboundDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return db;
}

describe('decideHeal', () => {
  it('no-ops when container_status is stopped', () => {
    expect(decideHeal({ containerStatus: 'stopped', isRunning: false, hasProcessingClaim: false })).toEqual({
      resetFlag: false,
      injectNudge: false,
      wake: false,
    });
  });

  it('no-ops when container_status is idle', () => {
    expect(decideHeal({ containerStatus: 'idle', isRunning: false, hasProcessingClaim: false })).toEqual({
      resetFlag: false,
      injectNudge: false,
      wake: false,
    });
  });

  it('no-ops when flagged running and the container actually is running', () => {
    expect(decideHeal({ containerStatus: 'running', isRunning: true, hasProcessingClaim: false })).toEqual({
      resetFlag: false,
      injectNudge: false,
      wake: false,
    });
  });

  it('resets only (no nudge/wake) when an unacked processing claim exists — host-sweep owns it', () => {
    expect(decideHeal({ containerStatus: 'running', isRunning: false, hasProcessingClaim: true })).toEqual({
      resetFlag: true,
      injectNudge: false,
      wake: false,
    });
  });

  it('resets + nudges + wakes when the claim already completed but the stream was interrupted', () => {
    expect(decideHeal({ containerStatus: 'running', isRunning: false, hasProcessingClaim: false })).toEqual({
      resetFlag: true,
      injectNudge: true,
      wake: true,
    });
  });
});

describe('reconcileSessionsOnBoot', () => {
  it('chawanrat case: stale running, no processing claim (completed-but-interrupted), not running -> reset + nudge + wake', async () => {
    const session = makeSession();
    const outDb = makeOutboundDb();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'completed', ?)").run(new Date().toISOString());

    const markContainerStopped = vi.fn();
    const writeSessionMessage = vi.fn();
    const wakeContainer = vi.fn().mockResolvedValue(true);
    const getSession = vi.fn().mockReturnValue(session);

    const deps: HealDeps = {
      getActiveSessions: () => [session],
      isContainerRunning: () => false,
      openOutboundDb: () => outDb,
      getProcessingClaims,
      markContainerStopped,
      writeSessionMessage,
      getSession,
      wakeContainer,
    };

    await reconcileSessionsOnBoot(deps);

    expect(markContainerStopped).toHaveBeenCalledWith('sess-1');
    expect(writeSessionMessage).toHaveBeenCalledTimes(1);

    const [agentGroupId, sessionId, message] = writeSessionMessage.mock.calls[0];
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-1');
    expect(message.onWake).toBe(1);
    expect(message.channelType).toBe('agent');
    expect(message.kind).toBe('chat');
    const content = JSON.parse(message.content);
    expect(content.sender).toBe('system');
    expect(content.senderId).toBe('system');
    expect(content.text).toBe(RESUME_NUDGE);

    expect(wakeContainer).toHaveBeenCalledWith(session);
  });

  it('unacked processing claim -> reset only, no nudge, no wake (host-sweep re-wakes the unacked turn)', async () => {
    const session = makeSession();
    const outDb = makeOutboundDb();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(new Date().toISOString());

    const markContainerStopped = vi.fn();
    const writeSessionMessage = vi.fn();
    const wakeContainer = vi.fn().mockResolvedValue(true);

    const deps: HealDeps = {
      getActiveSessions: () => [session],
      isContainerRunning: () => false,
      openOutboundDb: () => outDb,
      getProcessingClaims,
      markContainerStopped,
      writeSessionMessage,
      getSession: vi.fn().mockReturnValue(session),
      wakeContainer,
    };

    await reconcileSessionsOnBoot(deps);

    expect(markContainerStopped).toHaveBeenCalledWith('sess-1');
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('a healthy stopped session is left untouched (and outbound.db is never opened)', async () => {
    const session = makeSession({ container_status: 'stopped' });
    const openOutboundDb = vi.fn();
    const markContainerStopped = vi.fn();
    const writeSessionMessage = vi.fn();
    const wakeContainer = vi.fn();

    const deps: HealDeps = {
      getActiveSessions: () => [session],
      isContainerRunning: () => false,
      openOutboundDb,
      getProcessingClaims,
      markContainerStopped,
      writeSessionMessage,
      getSession: vi.fn(),
      wakeContainer,
    };

    await reconcileSessionsOnBoot(deps);

    expect(openOutboundDb).not.toHaveBeenCalled();
    expect(markContainerStopped).not.toHaveBeenCalled();
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('idempotent: a second boot after a heal finds container_status=stopped -> skipped entirely', async () => {
    const session = makeSession({ container_status: 'stopped' });
    const markContainerStopped = vi.fn();

    const deps: HealDeps = {
      getActiveSessions: () => [session],
      isContainerRunning: () => false,
      openOutboundDb: vi.fn(),
      getProcessingClaims,
      markContainerStopped,
      writeSessionMessage: vi.fn(),
      getSession: vi.fn(),
      wakeContainer: vi.fn(),
    };

    await reconcileSessionsOnBoot(deps);
    expect(markContainerStopped).not.toHaveBeenCalled();
  });

  it('a session whose reconcile throws does not block the rest of the loop', async () => {
    const badSession = makeSession({ id: 'sess-bad', agent_group_id: 'ag-bad' });
    const goodSession = makeSession({ id: 'sess-good', agent_group_id: 'ag-good' });
    const outDb = makeOutboundDb(); // no rows -> completed-but-interrupted path for the good session

    const markContainerStopped = vi.fn();
    const writeSessionMessage = vi.fn();
    const wakeContainer = vi.fn().mockResolvedValue(true);
    const getSession = vi.fn().mockReturnValue(goodSession);

    const deps: HealDeps = {
      getActiveSessions: () => [badSession, goodSession],
      isContainerRunning: (sessionId) => {
        if (sessionId === 'sess-bad') throw new Error('boom');
        return false;
      },
      openOutboundDb: () => outDb,
      getProcessingClaims,
      markContainerStopped,
      writeSessionMessage,
      getSession,
      wakeContainer,
    };

    await expect(reconcileSessionsOnBoot(deps)).resolves.toBeUndefined();

    expect(markContainerStopped).toHaveBeenCalledTimes(1);
    expect(markContainerStopped).toHaveBeenCalledWith('sess-good');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(wakeContainer).toHaveBeenCalledWith(goodSession);
  });
});
