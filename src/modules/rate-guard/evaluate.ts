/**
 * M08 headcount rate-guard — the PURE planner.
 *
 * A side-effect-free decision function: given the current time, the recent
 * provision events inside the window, the configured thresholds, and the
 * caller context, it decides whether one more provision is allowed or trips a
 * rate limit. It does NO I/O — no clock, no DB, no logging — so it is fully
 * unit-testable (`now` and `recent` are injected). The caller (a later phase)
 * reads recent events from the durable `provision_events` store, runs this,
 * and records the event AFTER an `allow` so a tripped attempt is not
 * double-counted into its own window (SPEC-M08 §4.1).
 *
 * Scope precedence (SPEC-M08 §4.1 ordering): creator -> global -> domain. The
 * order only matters when two scopes would trip simultaneously; a domain trip
 * still fires while under creator+global because those simply do not trip.
 */

export type RateDecision =
  | { kind: 'allow'; reason?: string }
  | { kind: 'trip'; scope: 'creator' | 'global' | 'domain'; count: number; limit: number };

export interface RateThresholds {
  perCreatorPerWindow: number;
  globalPerWindow: number;
  perDomainPerWindow: number;
  windowMs: number;
}

export interface RateEvent {
  ts: number;
  creatorId: string;
  domain?: string | null;
}

export interface RateContext {
  creatorId: string;
  domain?: string | null;
  burstAllowed?: boolean;
}

/**
 * Decide whether one more provision is allowed.
 *
 * @param now        injected clock (epoch ms) — keeps the planner pure.
 * @param recent     provision events to consider (re-filtered to the window here).
 * @param thresholds per-creator / global / per-domain limits + window length.
 * @param ctx        the requesting creator, optional verified domain, burst flag.
 */
export function evaluateRateGuard(
  now: number,
  recent: RateEvent[],
  thresholds: RateThresholds,
  ctx: RateContext,
): RateDecision {
  // AC12 — burst allowlist bypass: an owner-allowlisted creator/domain is
  // allowed regardless of counts, BEFORE any threshold check (still recorded +
  // logged by the caller, so the burst stays auditable).
  if (ctx.burstAllowed === true) {
    return { kind: 'allow', reason: 'burst-allowlisted' };
  }

  // AC2 — only count events inside the window. Exclusive lower bound
  // (`ts > now - windowMs`): an event exactly windowMs old has aged out. Kept
  // identical to the durable store's SELECT so planner + store agree.
  const windowStart = now - thresholds.windowMs;
  const inWindow = recent.filter((e) => e.ts > windowStart);

  // AC2/AC3 — creator scope: events from the requesting creator. `>=` so the
  // limit-th event in the window is the one that trips (the N+1 create blocks).
  const creatorCount = inWindow.filter((e) => e.creatorId === ctx.creatorId).length;
  if (creatorCount >= thresholds.perCreatorPerWindow) {
    return { kind: 'trip', scope: 'creator', count: creatorCount, limit: thresholds.perCreatorPerWindow };
  }

  // AC2 — global scope: all events in the window, any creator/domain.
  const globalCount = inWindow.length;
  if (globalCount >= thresholds.globalPerWindow) {
    return { kind: 'trip', scope: 'global', count: globalCount, limit: thresholds.globalPerWindow };
  }

  // AC10 — domain scope: active ONLY when ctx carries a domain (the SSO path).
  // null/empty is not a matchable key — a non-SSO/exempt caller with no domain
  // skips this dimension entirely (never blocks for genuinely-missing data).
  if (ctx.domain != null && ctx.domain !== '') {
    const domainCount = inWindow.filter((e) => e.domain === ctx.domain).length;
    if (domainCount >= thresholds.perDomainPerWindow) {
      return { kind: 'trip', scope: 'domain', count: domainCount, limit: thresholds.perDomainPerWindow };
    }
  }

  // AC2 — under every applicable limit.
  return { kind: 'allow' };
}
