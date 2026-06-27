/**
 * M08 rate-guard barrel — the pure planner + its types, and the durable
 * window-store helpers. The later hook phase (and the Circle-side caller) wire
 * against these exports.
 */
export { evaluateRateGuard } from './evaluate.js';
export type { RateDecision, RateThresholds, RateEvent, RateContext } from './evaluate.js';
export { recordProvisionEvent, recentProvisionEvents, pruneProvisionEvents } from './store.js';
