/**
 * Unit table for the pure M08 rate-guard planner (`evaluateRateGuard`).
 *
 * Covers the pure-planner-testable acceptance criteria of SPEC-M08:
 *   - AC2:  allow under all limits; trip with correct scope/count/limit at/above each.
 *   - AC3:  the N+1 create from one creator trips scope:'creator'.
 *   - AC10: the per-domain dimension is active only when a domain tag is present;
 *           a domain trip fires even while UNDER creator+global; no-domain ctx
 *           skips the domain dimension entirely (never blocks for missing data).
 *   - AC12: burstAllowed bypasses a would-be trip -> allow(reason:'burst-allowlisted').
 *   - Window: events older than the window boundary are not counted.
 *   - Precedence: when two scopes would trip, creator is reported before global.
 *
 * The planner is pure: `now` + `recent` are injected, no clock/db/I/O.
 */
import { describe, it, expect } from 'vitest';

import { evaluateRateGuard } from './evaluate.js';
import type { RateThresholds, RateEvent, RateContext } from './evaluate.js';

const WINDOW = 3_600_000; // 1h
const NOW = 1_000_000_000;

function thresholds(over: Partial<RateThresholds> = {}): RateThresholds {
  return {
    perCreatorPerWindow: 3,
    globalPerWindow: 5,
    perDomainPerWindow: 4,
    windowMs: WINDOW,
    ...over,
  };
}

/** Build n events for a creator/domain, all fresh inside the window. */
function events(n: number, creatorId: string, domain?: string | null): RateEvent[] {
  return Array.from({ length: n }, (_, i) => ({ ts: NOW - (i + 1) * 1000, creatorId, domain }));
}

describe('evaluateRateGuard — allow paths', () => {
  it('allows when there are no recent events', () => {
    // Arrange
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, [], thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('allows when every scope is strictly under its limit', () => {
    // Arrange — 2 creator events (< 3), 2 global (< 5), no domain dimension
    const recent = events(2, 'ag-A');
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'allow' });
  });
});

describe('evaluateRateGuard — creator scope (AC2/AC3)', () => {
  it('trips scope:creator at exactly perCreatorPerWindow (>= comparison)', () => {
    // Arrange — 3 events for ag-A, limit 3
    const recent = events(3, 'ag-A');
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'trip', scope: 'creator', count: 3, limit: 3 });
  });

  it('counts only the requesting creator, not other creators', () => {
    // Arrange — ag-A has 2 (< 3), ag-B has 3 but is not the ctx creator
    const recent = [...events(2, 'ag-A'), ...events(3, 'ag-B')];
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act — global is 5 (== globalPerWindow 5) so this would trip GLOBAL,
    // but creator (2) is under; assert it does NOT trip on creator.
    const decision = evaluateRateGuard(NOW, recent, thresholds({ globalPerWindow: 99 }), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'allow' });
  });
});

describe('evaluateRateGuard — global scope (AC2)', () => {
  it('trips scope:global at exactly globalPerWindow when no single creator trips', () => {
    // Arrange — 5 events spread so no creator reaches 3; global limit 5
    const recent = [
      ...events(2, 'ag-A'),
      ...events(2, 'ag-B'),
      ...events(1, 'ag-C'),
    ];
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'trip', scope: 'global', count: 5, limit: 5 });
  });
});

describe('evaluateRateGuard — domain scope (AC10)', () => {
  it('trips scope:domain when a domain tag is present and at the per-domain limit, even under creator+global', () => {
    // Arrange — 4 events for domain trirat.co spread across 4 creators
    // (each creator has 1 < 3, global 4 < 5), domain limit 4.
    const recent = [
      ...events(1, 'ag-A', 'trirat.co'),
      ...events(1, 'ag-B', 'trirat.co'),
      ...events(1, 'ag-C', 'trirat.co'),
      ...events(1, 'ag-D', 'trirat.co'),
    ];
    const ctx: RateContext = { creatorId: 'ag-A', domain: 'trirat.co' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'trip', scope: 'domain', count: 4, limit: 4 });
  });

  it('skips the domain dimension when ctx has no domain (never blocks for missing data)', () => {
    // Arrange — 4 events all tagged trirat.co (would trip domain) but ctx has no domain.
    const recent = events(4, 'ag-A', 'trirat.co');
    const ctx: RateContext = { creatorId: 'ag-A' }; // no domain

    // Act — global limit lifted so only the domain dimension could trip;
    // creator is 4 >= 3 so it WOULD trip creator. Use a separate creator-per-event
    // spread to isolate the domain-skip behavior.
    const spread = [
      ...events(1, 'ag-A', 'trirat.co'),
      ...events(1, 'ag-B', 'trirat.co'),
      ...events(1, 'ag-C', 'trirat.co'),
      ...events(1, 'ag-D', 'trirat.co'),
    ];
    const decision = evaluateRateGuard(NOW, spread, thresholds(), ctx);

    // Assert — domain skipped, creator/global under -> allow
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('does not count a different domain toward ctx.domain', () => {
    // Arrange — 4 events for other.com, ctx.domain trirat.co has 0
    const recent = events(4, 'ag-A', 'other.com');
    const ctx: RateContext = { creatorId: 'ag-B', domain: 'trirat.co' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds({ globalPerWindow: 99, perCreatorPerWindow: 99 }), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'allow' });
  });
});

describe('evaluateRateGuard — window boundary', () => {
  it('does not count events at or before the exclusive window lower bound', () => {
    // Arrange — 3 creator events, but all are AT or before (now - windowMs).
    const boundary = NOW - WINDOW; // exclusive: ts must be > boundary to count
    const recent: RateEvent[] = [
      { ts: boundary, creatorId: 'ag-A' }, // exactly on the bound -> excluded
      { ts: boundary - 1, creatorId: 'ag-A' }, // older -> excluded
      { ts: boundary - 5000, creatorId: 'ag-A' }, // older -> excluded
    ];
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert — all aged out, nothing counted
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('counts an event just inside the window boundary', () => {
    // Arrange — 3 creator events all just inside (ts = boundary + 1)
    const boundary = NOW - WINDOW;
    const recent: RateEvent[] = [
      { ts: boundary + 1, creatorId: 'ag-A' },
      { ts: boundary + 2, creatorId: 'ag-A' },
      { ts: boundary + 3, creatorId: 'ag-A' },
    ];
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'trip', scope: 'creator', count: 3, limit: 3 });
  });
});

describe('evaluateRateGuard — burst allowlist (AC12)', () => {
  it('returns allow(reason:burst-allowlisted) before any threshold check', () => {
    // Arrange — way over every limit, but burst is allowed
    const recent = events(20, 'ag-A', 'trirat.co');
    const ctx: RateContext = { creatorId: 'ag-A', domain: 'trirat.co', burstAllowed: true };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'allow', reason: 'burst-allowlisted' });
  });

  it('still trips when burstAllowed is false', () => {
    // Arrange
    const recent = events(3, 'ag-A');
    const ctx: RateContext = { creatorId: 'ag-A', burstAllowed: false };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert
    expect(decision).toEqual({ kind: 'trip', scope: 'creator', count: 3, limit: 3 });
  });
});

describe('evaluateRateGuard — scope precedence', () => {
  it('reports scope:creator before scope:global when both would trip', () => {
    // Arrange — ag-A has 5 events: creator 5>=3 AND global 5>=5 both trip.
    const recent = events(5, 'ag-A');
    const ctx: RateContext = { creatorId: 'ag-A' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert — creator precedence per spec §4.1 ordering
    expect(decision).toEqual({ kind: 'trip', scope: 'creator', count: 5, limit: 3 });
  });

  it('reports scope:global before scope:domain when both would trip and creator is under', () => {
    // Arrange — domain trirat.co has 5 across 5 creators (each 1 < 3);
    // global 5 >= 5 trips, domain 5 >= 4 trips; creator under.
    const recent = [
      ...events(1, 'ag-A', 'trirat.co'),
      ...events(1, 'ag-B', 'trirat.co'),
      ...events(1, 'ag-C', 'trirat.co'),
      ...events(1, 'ag-D', 'trirat.co'),
      ...events(1, 'ag-E', 'trirat.co'),
    ];
    const ctx: RateContext = { creatorId: 'ag-A', domain: 'trirat.co' };

    // Act
    const decision = evaluateRateGuard(NOW, recent, thresholds(), ctx);

    // Assert — global precedes domain per spec §4.1 ordering
    expect(decision).toEqual({ kind: 'trip', scope: 'global', count: 5, limit: 5 });
  });
});
