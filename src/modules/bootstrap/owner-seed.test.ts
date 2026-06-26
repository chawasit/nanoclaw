/**
 * Tests for the M22 owner-seed primitive (SWEEP-3 §S3).
 *
 * The fix: the bootstrap must ADOPT/AUGMENT the live instance rather than refuse
 * it. The instance already has `cli:local` as owner (retained for pnpm chat /
 * the Secretary bridge); seeding the real `google:<sub>` owner must proceed
 * ALONGSIDE it. The single-owner guard keys on a conflicting *Google* owner
 * only. Acceptance: exactly one Google owner; `cli:local` retained.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserRole } from '../../types.js';
import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole, getOwners } from '../permissions/db/user-roles.js';
import { planOwnerSeed, seedOwner } from './owner-seed.js';

function ownerRow(userId: string): UserRole {
  return { user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: '2026-01-01T00:00:00Z' };
}

describe('planOwnerSeed — pure adopt/augment decision', () => {
  it('fresh instance (no owners): seeds the google owner', () => {
    const plan = planOwnerSeed([], 'sub-1');
    expect(plan.action).toBe('seed');
    expect(plan.principal).toBe('google:sub-1');
    expect(plan.retainedNonGoogleOwners).toEqual([]);
  });

  it('augment: only cli:local exists → seeds the google owner, retains cli:local', () => {
    const plan = planOwnerSeed([ownerRow('cli:local')], 'sub-1');
    expect(plan.action).toBe('seed');
    expect(plan.retainedNonGoogleOwners).toEqual(['cli:local']);
  });

  it('idempotent: the same google owner already exists → noop', () => {
    const plan = planOwnerSeed([ownerRow('cli:local'), ownerRow('google:sub-1')], 'sub-1');
    expect(plan.action).toBe('noop');
  });

  it('refuses a second, DIFFERENT google owner', () => {
    const plan = planOwnerSeed([ownerRow('google:sub-1')], 'sub-2');
    expect(plan.action).toBe('refuse');
    expect(plan.refusal).toBe('owner-exists-different-principal');
  });

  it('refuses a missing ownerGoogleSub', () => {
    const plan = planOwnerSeed([ownerRow('cli:local')], '');
    expect(plan.action).toBe('refuse');
    expect(plan.refusal).toBe('no-owner-googlesub');
  });
});

describe('seedOwner — executor against a real spine DB', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  /** Seed a pre-existing owner the hand-bootstrap way (users FK row + owner role). */
  function seedExistingOwner(userId: string, kind: string): void {
    upsertUser({ id: userId, kind, display_name: null, created_at: '2026-01-01T00:00:00Z' });
    grantRole({
      user_id: userId,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: '2026-01-01T00:00:00Z',
    });
  }

  function ownerIds(): string[] {
    return getOwners()
      .map((o) => o.user_id)
      .sort();
  }

  it('(a) augments the live cli:local owner: seeds google alongside, cli:local retained', () => {
    seedExistingOwner('cli:local', 'cli');

    const res = seedOwner({ ownerGoogleSub: 'sub-1', ownerEmail: 'boss@example.com' });

    expect(res.action).toBe('seed');
    expect(res.seeded).toEqual({ usersRow: 1, ownerRole: 1 });
    // Exactly one Google owner, and cli:local is still an owner (untouched).
    expect(ownerIds()).toEqual(['cli:local', 'google:sub-1']);
    const googleOwners = getOwners().filter((o) => o.user_id.startsWith('google:'));
    expect(googleOwners).toHaveLength(1);
    // The users FK row was written with kind='google' and the supplied email.
    const u = getDb().prepare('SELECT kind, display_name FROM users WHERE id = ?').get('google:sub-1') as {
      kind: string;
      display_name: string;
    };
    expect(u).toMatchObject({ kind: 'google', display_name: 'boss@example.com' });
  });

  it('(b) refuses a second, different Google owner and writes nothing', () => {
    seedExistingOwner('google:sub-1', 'google');

    const res = seedOwner({ ownerGoogleSub: 'sub-2' });

    expect(res.action).toBe('refuse');
    expect(res.refusal).toBe('owner-exists-different-principal');
    expect(res.seeded).toEqual({ usersRow: 0, ownerRole: 0 });
    // Owner set unchanged: still exactly the one original Google owner.
    expect(ownerIds()).toEqual(['google:sub-1']);
  });

  it('is idempotent: re-seeding the same google owner is a noop (no duplicate row)', () => {
    seedExistingOwner('cli:local', 'cli');
    seedOwner({ ownerGoogleSub: 'sub-1' });

    const res = seedOwner({ ownerGoogleSub: 'sub-1' });

    expect(res.action).toBe('noop');
    expect(res.seeded).toEqual({ usersRow: 0, ownerRole: 0 });
    expect(ownerIds()).toEqual(['cli:local', 'google:sub-1']);
  });
});
