/**
 * Outbound A2A transport tests. Network (fetch) is stubbed; the spine helpers
 * are mocked so no DB/container is needed. Verifies: flag-gating, ACL, the
 * message/send → tasks/get poll-to-terminal loop, and reply injection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockHasDestination = vi.fn();
const mockGetPeer = vi.fn();
const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn();
const mockGetSession = vi.fn();
const mockResolveSession = vi.fn();
const mockGetAgentGroup = vi.fn();

vi.mock('../agent-to-agent/db/agent-destinations.js', () => ({
  hasDestination: (...a: unknown[]) => mockHasDestination(...a),
}));
vi.mock('./db/a2a-peers.js', () => ({ getPeer: (...a: unknown[]) => mockGetPeer(...a) }));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockWriteSessionMessage(...a),
  resolveSession: (...a: unknown[]) => mockResolveSession(...a),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: (...a: unknown[]) => mockWakeContainer(...a) }));
vi.mock('../../db/sessions.js', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { routeA2aMessage } from './a2a-client.js';

const session = { id: 'sess-1', agent_group_id: 'ag-src', status: 'active' } as never;

function peerCard() {
  return { id: 'peer-1', name: 'Remote', endpoint: 'http://peer/a2a', auth_scheme: 'bearer', auth_token: 'tok', created_at: '' };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NANOCLAW_A2A_TRANSPORT_ENABLED = '1';
  mockHasDestination.mockReturnValue(true);
  mockGetPeer.mockReturnValue(peerCard());
  mockGetSession.mockReturnValue(session);
  mockResolveSession.mockReturnValue({ session, created: false });
  mockGetAgentGroup.mockReturnValue({ name: 'Source' });
});
afterEach(() => {
  delete process.env.NANOCLAW_A2A_TRANSPORT_ENABLED;
});

describe('routeA2aMessage', () => {
  it('throws when the flag is off (inert by default)', async () => {
    delete process.env.NANOCLAW_A2A_TRANSPORT_ENABLED;
    await expect(routeA2aMessage({ id: 'm', platform_id: 'peer-1', content: '{}', in_reply_to: null }, session)).rejects.toThrow(
      /disabled/,
    );
  });

  it('throws when the agent has no a2a destination (ACL)', async () => {
    mockHasDestination.mockReturnValue(false);
    await expect(
      routeA2aMessage({ id: 'm', platform_id: 'peer-1', content: '{}', in_reply_to: null }, session),
    ).rejects.toThrow(/unauthorized a2a/);
  });

  it('sends message/send, polls tasks/get to completed, and injects the reply', async () => {
    const calls: Array<{ method: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body);
      calls.push({ method: req.method });
      if (req.method === 'message/send') {
        return jsonRes({ result: { id: 'task-9', contextId: 'c', status: { state: 'working' } } });
      }
      // tasks/get → completed with a reply
      return jsonRes({
        result: { id: 'task-9', status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'peer says hi' }] } } },
      });
    });

    await routeA2aMessage(
      { id: 'm', platform_id: 'peer-1', content: JSON.stringify({ text: 'hello peer' }), in_reply_to: null },
      session,
      { fetchImpl: fetchImpl as unknown as typeof fetch, pollMs: 1, timeoutMs: 5000 },
    );

    expect(calls[0].method).toBe('message/send');
    expect(calls.some((c) => c.method === 'tasks/get')).toBe(true);
    // The peer's reply was injected back into the source session.
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const [ag, sid, payload] = mockWriteSessionMessage.mock.calls[0];
    expect(ag).toBe('ag-src');
    expect(sid).toBe('sess-1');
    expect(payload.channelType).toBe('a2a');
    expect(payload.platformId).toBe('peer-1');
    expect(JSON.parse(payload.content).text).toBe('peer says hi');
    expect(mockWakeContainer).toHaveBeenCalled();
  });

  it('throws when the peer is unknown', async () => {
    mockGetPeer.mockReturnValue(undefined);
    await expect(
      routeA2aMessage({ id: 'm', platform_id: 'peer-1', content: '{}', in_reply_to: null }, session),
    ).rejects.toThrow(/peer peer-1 not found/);
  });

  it('throws on a peer HTTP error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(
      routeA2aMessage({ id: 'm', platform_id: 'peer-1', content: '{}', in_reply_to: null }, session, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
