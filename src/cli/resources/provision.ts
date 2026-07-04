/**
 * `ncl provision` — Circle M03 auto-provision a principal-bound employee agent.
 *
 * Turns a verified, in-domain Google SSO sign-up into exactly ONE principal-bound
 * child agent directly under the main agent (the root CoS — flat topology, D30),
 * deterministically and idempotently. This is the privileged, spine-side half of
 * SPEC-M03: the Circle backend (a separate process that only RO-mounts v2.db)
 * computes the policy and invokes THIS command over the host-only `ncl.sock`,
 * which runs in-process with the spine and so can reuse the canonical create path
 * (`performCreateAgent`) instead of re-implementing it outside the spine.
 *
 * HOST-ONLY. The 0600 `ncl.sock` is the auth boundary (only the host user can
 * connect); the handler additionally HARD-REJECTS any non-host caller, so no
 * confined OR global agent can reach it via the per-session CLI path.
 *
 * What it codifies (the test-spine-validated dedicated-web-lane runbook —
 * see company/services/circle-backend/docs/dedicated-web-lane-design.md):
 *   1. domain gate (fail-closed) against PROVISION_ALLOWED_DOMAINS
 *   2. idempotency: an existing agent_group_members row for google:<sub> short-
 *      circuits — return the existing agent, never a second one (D5 one-per-human)
 *   3. upsertUser(google:<sub>)  — the users-row FK prerequisite for the binding
 *   4. performCreateAgent under the main agent with the principal binding (S1)
 *   5. apply a $0 local model + endpoint env (HOST CONFIG — never baked into the
 *      public fork) so sign-up never auto-spends (D11/D33)
 *   6. web lane: messaging_groups (cli / web:google:<sub> / instance=cli, named
 *      after the human's email) + the `user` reply-routing destination + the
 *      messaging_group_agents wiring
 *   7. mint the pollable, clean-origin session via routeInbound (engages + wakes)
 *
 * Deferred to later M03 slices (graceful degradation per SPEC-M03 §6): offboard /
 * OBO-revoke / denylist (M02/M01, Phase 3), provision-failed notify (M17), the
 * domain-keyed rate-guard (M08 remainder), and the full E1 lock + transactional
 * rollback (only the cheap idempotency check + an in-process single-flight here).
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { createDestination } from '../../modules/agent-to-agent/db/agent-destinations.js';
import { performCreateAgent } from '../../modules/agent-to-agent/create-agent.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { routeInbound } from '../../router.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

export interface ProvisionArgs {
  googleSub: string;
  email: string;
  domain: string;
}

export type ProvisionRefusal =
  | 'not-host'
  | 'domain-not-allowed'
  | 'misconfigured'
  | 'no-main-agent'
  | 'no-main-agent-session'
  | 'concurrent-provision'
  | 'create-failed';

export interface ProvisionResult {
  ok: boolean;
  agentGroupId: string | null;
  created: boolean;
  refusals: ProvisionRefusal[];
  lane: { platformId: string; messagingGroupId: string | null };
}

/** Host config (outside the fork — chmod-600 env on Visor; never IPs in source). */
interface ProvisionConfig {
  allowedDomains: string[];
  mainAgentId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** Read + validate the host config. Returns null (misconfigured) if incomplete. */
function readConfig(): ProvisionConfig | null {
  const allowedDomains = (process.env.PROVISION_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const mainAgentId = (process.env.PROVISION_MAIN_AGENT_ID ?? '').trim();
  const model = (process.env.PROVISION_MODEL ?? '').trim();
  const baseUrl = (process.env.PROVISION_BASE_URL ?? '').trim();
  const apiKey = (process.env.PROVISION_API_KEY ?? 'ollama').trim();
  // Fail closed on any missing piece — a half-config must NOT silently create a
  // cloud-spending or wrongly-parented agent. The $0 model + endpoint are
  // REQUIRED so sign-up never auto-spends (D11/D33).
  if (allowedDomains.length === 0 || !mainAgentId || !model || !baseUrl) return null;
  return { allowedDomains, mainAgentId, model, baseUrl, apiKey };
}

/** The agent_group bound to a principal (its sole/earliest membership), or null. */
function existingBoundAgent(principal: string): string | null {
  const row = getDb()
    .prepare(
      'SELECT agent_group_id FROM agent_group_members WHERE user_id = ? ORDER BY added_at ASC, agent_group_id ASC LIMIT 1',
    )
    .get(principal) as { agent_group_id: string } | undefined;
  return row?.agent_group_id ?? null;
}

/** In-process single-flight: serialize concurrent first-provisions for one sub. */
const inFlight = new Set<string>();

function refuse(reason: ProvisionRefusal, platformId: string): ProvisionResult {
  return {
    ok: false,
    agentGroupId: null,
    created: false,
    refusals: [reason],
    lane: { platformId, messagingGroupId: null },
  };
}

/**
 * Apply the $0 local model + endpoint to the freshly-created agent's container
 * config. MERGES into the base-profile env (preserving MCP keys etc.) rather than
 * overwriting. The explicit `ANTHROPIC_BASE_URL` wins over proxy auto-injection at
 * spawn (a gemma/ampere endpoint is not proxy-routed), so the agent reaches the
 * $0 model. Must run BEFORE the session mint so the spawn materializes it.
 */
function applyZeroCostModel(agentGroupId: string, cfg: ProvisionConfig): void {
  updateContainerConfigScalars(agentGroupId, { model: cfg.model });
  const row = getContainerConfig(agentGroupId);
  const env = row ? (JSON.parse(row.env) as Record<string, string>) : {};
  const host = (() => {
    try {
      return new URL(cfg.baseUrl).hostname;
    } catch {
      return '';
    }
  })();
  const mergedEnv: Record<string, string> = {
    ...env,
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_API_KEY: cfg.apiKey,
    ...(host ? { NO_PROXY: host, no_proxy: host } : {}),
  };
  updateContainerConfigJson(agentGroupId, 'env', mergedEnv);

  const blocked = new Set(row ? (JSON.parse(row.blocked_hosts) as string[]) : []);
  blocked.add('api.anthropic.com');
  updateContainerConfigJson(agentGroupId, 'blocked_hosts', [...blocked]);
}

/**
 * Wire the dedicated web lane: a `cli` messaging group with a UNIQUE platform id,
 * the `user` reply-routing destination, and the agent wiring. The cli adapter
 * no-ops delivery for a non-`local` platform id, so replies route NOWHERE external
 * — Circle tails the session's outbound.db. Returns the lane mg id.
 *
 * The mg is named after the human's email (not the raw `web:google:<sub>`
 * platform id) so an agent reading `<message from="user">` — or the "Your
 * user" system-prompt block (dev-log: the chawanrat misroute, a report sent
 * to `parent` instead of the human owner) — sees a real, readable identity.
 */
function wireWebLane(agentGroupId: string, platformId: string, email: string, now: string): string {
  const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroup({
    id: mgId,
    channel_type: 'cli',
    platform_id: platformId,
    instance: 'cli',
    name: email,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  // The reply-routing destination is named `user` (was `local-cli` — renamed
  // 2026-07: nothing else in the repo keys off that literal string for routing,
  // only this file + its own test wrote/asserted it — see the destinations.ts
  // findByRouting/originAttr resolution, which keys off channel_type+platform_id,
  // not the local_name). Create it FIRST so the wiring's auto-destination (which
  // derives a name from mg.name) is skipped — `createMessagingGroupAgent` no-ops
  // the destination when one already targets this mg. Without `user` the
  // `<message to="user">` reply is dropped.
  createDestination({
    agent_group_id: agentGroupId,
    local_name: 'user',
    target_type: 'channel',
    target_id: mgId,
    created_at: now,
  });
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.', // sentinel: engage on every message
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  return mgId;
}

/**
 * Mint the pollable, clean-origin session by routing one bootstrap message at the
 * lane — the same path the cli.sock route-opcode drives, but in-process and
 * awaitable. `routeInbound` finds the just-wired lane (agentCount=1), engages the
 * agent (engage_pattern '.'), creates the `active` session with origin = the lane
 * mg, and wakes the container. The reply no-ops through the cli adapter.
 */
async function mintSession(platformId: string): Promise<void> {
  const event: InboundEvent = {
    channelType: 'cli',
    platformId,
    instance: 'cli',
    threadId: null,
    message: {
      id: `provision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        text: 'Your Circle workspace is ready. Say hello to your owner when they message you.',
        sender: 'system',
        senderId: 'system:provision',
      }),
    },
  };
  await routeInbound(event);
}

export async function provision(args: ProvisionArgs, ctx: CallerContext): Promise<ProvisionResult> {
  const principal = `google:${args.googleSub}`;
  const platformId = `web:google:${args.googleSub}`;

  // HARD host-only gate — privileged control-plane write.
  if (ctx.caller !== 'host') {
    log.warn('provision rejected: non-host caller', { caller: ctx.caller });
    return refuse('not-host', platformId);
  }

  const cfg = readConfig();
  if (!cfg) {
    log.error('provision misconfigured — missing PROVISION_ALLOWED_DOMAINS / MAIN_AGENT_ID / MODEL / BASE_URL');
    return refuse('misconfigured', platformId);
  }

  // Domain gate (fail-closed): the only POSITIVE creation gate (D10, G-C).
  if (!cfg.allowedDomains.includes(args.domain.toLowerCase())) {
    log.warn('provision denied: domain not allowed', { domain: args.domain });
    return refuse('domain-not-allowed', platformId);
  }

  // Idempotency (D5 one-human-one-agent): an existing binding short-circuits.
  const existing = existingBoundAgent(principal);
  if (existing) {
    return {
      ok: true,
      agentGroupId: existing,
      created: false,
      refusals: [],
      lane: { platformId, messagingGroupId: null },
    };
  }

  if (inFlight.has(principal)) return refuse('concurrent-provision', platformId);
  inFlight.add(principal);
  try {
    // Re-check inside the lock (TOCTOU): another flight may have just bound it.
    const recheck = existingBoundAgent(principal);
    if (recheck) {
      return {
        ok: true,
        agentGroupId: recheck,
        created: false,
        refusals: [],
        lane: { platformId, messagingGroupId: null },
      };
    }

    const mainGroup = getAgentGroup(cfg.mainAgentId);
    if (!mainGroup) {
      log.error('provision: main agent group not found', { mainAgentId: cfg.mainAgentId });
      return refuse('no-main-agent', platformId);
    }
    // performCreateAgent projects the new child destination into the CREATOR's
    // running session inbound.db, so the main agent needs an active session.
    const mainSession = findSessionByAgentGroup(cfg.mainAgentId);
    if (!mainSession) {
      log.error('provision: main agent has no active session', { mainAgentId: cfg.mainAgentId });
      return refuse('no-main-agent-session', platformId);
    }

    const now = new Date().toISOString();
    // FK prerequisite: ensure the users row before the binding write (idempotent).
    upsertUser({ id: principal, kind: 'google', display_name: args.email, created_at: now });

    const localPart = args.email.split('@')[0] || 'employee';
    const instructions = `You are the personal Circle agent for ${args.email}. You report to the Chief of Staff and help your owner with their work.`;
    const created = await performCreateAgent(
      localPart,
      instructions,
      mainSession,
      mainGroup,
      (text) => log.info('provision create_agent notice', { text }),
      { principalUserId: principal, domain: args.domain },
    );
    if (!created) {
      log.error('provision: performCreateAgent returned null', { principal });
      return refuse('create-failed', platformId);
    }

    applyZeroCostModel(created.id, cfg);
    const mgId = wireWebLane(created.id, platformId, args.email, now);
    await mintSession(platformId);

    log.info('provision: agent created + bound + wired', {
      agentGroupId: created.id,
      principal,
      domain: args.domain,
      lane: mgId,
    });
    return {
      ok: true,
      agentGroupId: created.id,
      created: true,
      refusals: [],
      lane: { platformId, messagingGroupId: mgId },
    };
  } finally {
    inFlight.delete(principal);
  }
}

register<ProvisionArgs, ProvisionResult>({
  name: 'provision',
  description:
    'Circle M03: auto-provision a principal-bound employee agent under the main agent on a verified, in-domain Google SSO sign-up. Host-only; idempotent. Args: --google_sub --email --domain.',
  access: 'open', // host-only is enforced in the handler (the ncl.sock 0600 boundary + the caller check)
  parseArgs: (raw) => {
    const googleSub = typeof raw.google_sub === 'string' ? raw.google_sub.trim() : '';
    const email = typeof raw.email === 'string' ? raw.email.trim() : '';
    const domain = typeof raw.domain === 'string' ? raw.domain.trim() : '';
    if (!googleSub) throw new Error('--google_sub is required');
    if (!email) throw new Error('--email is required');
    if (!domain) throw new Error('--domain is required');
    return { googleSub, email, domain };
  },
  handler: provision,
});
