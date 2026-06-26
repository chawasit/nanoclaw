/**
 * Owner-seed primitive for the Circle instance bootstrap (M22).
 *
 * M22 (`company/services/bootstrap/` in chawasit/circle) owns the full
 * `bootstrapInstance` procedure — CoS adoption, the domain-allowlist artifact,
 * the bootstrap marker, the audit emit, dryRun. This fork module owns only the
 * one decision M22 cannot make safely on its own: whether to seed the
 * `google:<sub>` owner as the trust root, given whatever owner rows already
 * exist on the live spine.
 *
 * SWEEP-3 §S3 — adopt/augment, not refuse. The live instance was bootstrapped
 * by hand with `cli:local` as owner (retained for `pnpm chat` / the Secretary
 * bridge). A naive "refuse if any owner row exists for a different principal"
 * would refuse the exact migration M22 exists to perform. So the single-owner
 * guard keys on a conflicting *Google* owner ONLY; any non-Google owner (the
 * known bootstrap `cli:local`) is left untouched and the Google owner is seeded
 * ALONGSIDE it. Acceptance: exactly one Google owner; `cli:local` retained.
 */
import type { UserRole } from '../../types.js';
import { getOwners, grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';

/** Principal-id prefix for Google-SSO identities (frozen convention, C1/M01). */
const GOOGLE_PREFIX = 'google:';

export type OwnerSeedAction = 'seed' | 'noop' | 'refuse';
export type OwnerSeedRefusal = 'no-owner-googlesub' | 'owner-exists-different-principal';

export interface OwnerSeedPlan {
  action: OwnerSeedAction;
  /** The principal this run targets, `google:<sub>`. */
  principal: string;
  refusal?: OwnerSeedRefusal;
  /** Non-Google owner principals left in place (e.g. `['cli:local']`) — proof of retention. */
  retainedNonGoogleOwners: string[];
}

/**
 * Pure decision (no I/O) over the existing owner rows + the new owner's Google
 * `sub`. Split out for unit testing per SPEC-M22 §4.
 *
 * - missing `ownerGoogleSub` → refuse `no-owner-googlesub`.
 * - the same `google:<sub>` already owns → `noop` (idempotent; never re-INSERT
 *   the owner row — `grantRole` is a bare INSERT and would throw on the PK).
 * - a DIFFERENT `google:<sub>` already owns → refuse `owner-exists-different-principal`.
 * - no Google owner yet (fresh, or only `cli:local`) → `seed`.
 */
export function planOwnerSeed(existingOwners: UserRole[], ownerGoogleSub: string): OwnerSeedPlan {
  const principal = `${GOOGLE_PREFIX}${ownerGoogleSub}`;
  const ownerIds = existingOwners.map((o) => o.user_id);
  const retainedNonGoogleOwners = ownerIds.filter((id) => !id.startsWith(GOOGLE_PREFIX));

  if (!ownerGoogleSub) {
    return { action: 'refuse', principal, refusal: 'no-owner-googlesub', retainedNonGoogleOwners };
  }

  const googleOwners = ownerIds.filter((id) => id.startsWith(GOOGLE_PREFIX));
  if (googleOwners.includes(principal)) {
    return { action: 'noop', principal, retainedNonGoogleOwners };
  }
  if (googleOwners.length > 0) {
    return { action: 'refuse', principal, refusal: 'owner-exists-different-principal', retainedNonGoogleOwners };
  }
  return { action: 'seed', principal, retainedNonGoogleOwners };
}

export interface SeedOwnerResult extends OwnerSeedPlan {
  seeded: { usersRow: 0 | 1; ownerRole: 0 | 1 };
}

/**
 * Executor: read the current owners, plan, and on `seed` write the owner trust
 * root — `upsertUser` (FK prereq) then the owner `user_roles` row
 * (`agent_group_id=NULL`, `granted_by=NULL`, never a sentinel). Idempotent and
 * never destructive: a `noop`/`refuse` writes nothing, and `cli:local` is never
 * touched. M22 owns the surrounding `v2.db` transaction, the bootstrap marker,
 * the allowlist artifact, and the audit emit — this only seeds the owner.
 */
export function seedOwner(opts: { ownerGoogleSub: string; ownerEmail?: string | null }): SeedOwnerResult {
  const plan = planOwnerSeed(getOwners(), opts.ownerGoogleSub);
  const seeded: SeedOwnerResult['seeded'] = { usersRow: 0, ownerRole: 0 };

  if (plan.action === 'seed') {
    const now = new Date().toISOString();
    upsertUser({ id: plan.principal, kind: 'google', display_name: opts.ownerEmail ?? null, created_at: now });
    seeded.usersRow = 1;
    grantRole({ user_id: plan.principal, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
    seeded.ownerRole = 1;
  }

  return { ...plan, seeded };
}
