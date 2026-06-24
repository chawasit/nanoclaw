/**
 * Outbound A2A transport client.
 *
 * When CoS/MD `send_message(to="<a2a-peer>")`, the container writes an outbound
 * row with `channel_type='a2a'` + `platform_id=<peerId>`. The host delivery loop
 * (src/delivery.ts) dynamic-imports this module's `routeA2aMessage` for that
 * branch — mirroring the existing `channel_type==='agent'` → `routeAgentMessage`
 * seam.
 *
 * This sends `message/send` to the remote peer's JSON-RPC endpoint, then watches
 * the returned Task (`tasks/get` poll) until terminal, and injects the peer's
 * reply back into the originating CoS/MD session via `writeSessionMessage` +
 * `wakeContainer` — so to CoS/MD a remote A2A peer "feels like" any other agent
 * that replies asynchronously.
 *
 * PURELY ADDITIVE + FLAG-GATED: inert unless `NANOCLAW_A2A_TRANSPORT_ENABLED`
 * is set AND an `a2a_peers` row + an `agent_destinations target_type='a2a'` row
 * exist. With the flag off, the delivery branch throws → retry → mark-failed,
 * exactly the unauthorized-channel path; prod is unaffected.
 *
 * ⚠️  PRE-ENABLE REFACTOR REQUIRED — DO NOT FLIP THE FLAG IN PROD AS-IS.
 * `routeA2aMessage` is `await`ed inside `deliverMessage` → `drainSession` →
 * `pollActive`'s SEQUENTIAL session loop, but it BLOCKS polling `tasks/get`
 * until the peer's Task is terminal (up to `timeoutMs`). So a single slow peer
 * would freeze the active delivery poll for EVERY session company-wide until it
 * completes/times-out. The existing `'agent'` seam (`routeAgentMessage`) never
 * does this — it writes-and-wakes in sub-second and returns. Before enabling,
 * refactor to mirror the INBOUND design: deliver = POST `message/send` + store
 * the peer's taskId, return immediately; a separate background watcher polls
 * `tasks/get` and injects the reply (an outbound correlation store + watcher in
 * the fork). Until then this is committed but unsafe-to-enable. (See dev-log.)
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { getSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { hasDestination } from '../agent-to-agent/db/agent-destinations.js';
import { getPeer } from './db/a2a-peers.js';

/** A2A JSON-RPC wire strings (mirror company/services/a2a-adapter/src/a2a.js). */
const A2A_METHOD_SEND = 'message/send';
const A2A_METHOD_GET = 'tasks/get';
const A2A_TERMINAL = new Set(['completed', 'canceled', 'rejected', 'failed']);

export interface OutboundA2aMessage {
  id: string;
  /** The peer id (from the a2a destination's platform_id). */
  platform_id: string | null;
  content: string;
  in_reply_to: string | null;
}

function flagEnabled(): boolean {
  return process.env.NANOCLAW_A2A_TRANSPORT_ENABLED === '1' || process.env.NANOCLAW_A2A_TRANSPORT_ENABLED === 'true';
}

/** Parse the outbound content JSON → the prompt text. */
function extractText(contentStr: string): string {
  try {
    const parsed = JSON.parse(contentStr) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : contentStr;
  } catch {
    return contentStr;
  }
}

/** POST a JSON-RPC request to a peer and return the parsed result (or throw). */
async function peerRpc(
  endpoint: string,
  authToken: string | null,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`peer rpc ${method} → HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`peer rpc ${method} error: ${body.error.message ?? 'unknown'}`);
  return body.result;
}

/** Pull the reply text out of a completed A2A Task's status.message. */
function taskReplyText(task: unknown): string | null {
  const t = task as { status?: { message?: { parts?: Array<{ kind?: string; text?: string }> } } };
  const parts = t?.status?.message?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p) => p && p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
  return text || null;
}

/**
 * Deliver an outbound `a2a` message to a remote peer. Authorization is the
 * existing ACL (`hasDestination(ag,'a2a',peerId)`); the agent must have an `a2a`
 * destination row. Throws on any failure → the delivery loop retries → mark-failed
 * (same as today's unauthorized-channel path).
 *
 * @param msg the outbound row (channel_type already known to be 'a2a')
 * @param session the source CoS/MD session
 * @param deps injectable for tests (fetch, watch loop knobs)
 */
export async function routeA2aMessage(
  msg: OutboundA2aMessage,
  session: Session,
  deps: { fetchImpl?: typeof fetch; pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  if (!flagEnabled()) {
    throw new Error('a2a-transport disabled (set NANOCLAW_A2A_TRANSPORT_ENABLED=1 to enable)');
  }
  const sourceAgentGroupId = session.agent_group_id;
  const peerId = msg.platform_id;
  if (!peerId) throw new Error(`a2a message ${msg.id} missing peer id`);
  if (!hasDestination(sourceAgentGroupId, 'a2a', peerId)) {
    throw new Error(`unauthorized a2a: ${sourceAgentGroupId} has no destination for peer ${peerId}`);
  }
  const peer = getPeer(peerId);
  if (!peer) throw new Error(`a2a peer ${peerId} not found`);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
  const text = extractText(msg.content);

  // 1. message/send → Task.
  const sendResult = (await peerRpc(
    peer.endpoint,
    peer.auth_token,
    A2A_METHOD_SEND,
    { message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text }] } },
    fetchImpl,
  )) as { id?: string; contextId?: string; status?: { state?: string } };
  const taskId = sendResult?.id;
  if (!taskId) throw new Error(`peer ${peerId} message/send returned no task id`);
  log.info('A2A outbound sent', { from: sourceAgentGroupId, peer: peerId, taskId });

  // 2. Watch the Task until terminal (poll tasks/get).
  let task: unknown = sendResult;
  let state = sendResult?.status?.state ?? 'working';
  const deadline = Date.now() + timeoutMs;
  while (!A2A_TERMINAL.has(state)) {
    if (Date.now() > deadline) throw new Error(`peer ${peerId} task ${taskId} timed out`);
    await new Promise((r) => setTimeout(r, pollMs));
    task = await peerRpc(peer.endpoint, peer.auth_token, A2A_METHOD_GET, { id: taskId }, fetchImpl);
    state = (task as { status?: { state?: string } })?.status?.state ?? 'working';
  }

  // 3. Inject the peer's reply back into the originating session.
  const reply = taskReplyText(task) ?? `(peer ${peer.name} task ${state} with no reply text)`;
  injectPeerReply(sourceAgentGroupId, session, peerId, reply);
}

/** Write the peer's reply into the source agent's session + wake it. */
function injectPeerReply(agentGroupId: string, originSession: Session, peerId: string, text: string): void {
  // Land the reply in the session that sent it (origin), falling back to the
  // agent's shared session if the origin is gone.
  const fresh = getSession(originSession.id);
  const target =
    fresh && fresh.status === 'active'
      ? fresh
      : resolveSession(agentGroupId, null, null, 'agent-shared').session;
  const a2aMsgId = `a2a-peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(agentGroupId, target.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: peerId,
    channelType: 'a2a',
    threadId: null,
    content: JSON.stringify({ text }),
    sourceSessionId: target.id,
  });
  const name = getAgentGroup(agentGroupId)?.name ?? agentGroupId;
  log.info('A2A peer reply injected', { agent: name, peer: peerId, targetSession: target.id });
  const woke = getSession(target.id);
  if (woke) void wakeContainer(woke);
}
