/**
 * Tests for the M08 durable window-store helpers against an in-memory
 * better-sqlite3 DB created from migration 020.
 *
 * Covers: record -> recent round-trip (incl. creator_id<->creatorId mapping and
 * a null domain), the exclusive window filter in recentProvisionEvents, and
 * pruneProvisionEvents deleting only aged-out rows + returning the count.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { migration020 } from '../../db/migrations/020-provision-events.js';
import { recordProvisionEvent, recentProvisionEvents, pruneProvisionEvents } from './store.js';

const WINDOW = 3_600_000; // 1h
const NOW = 1_000_000_000;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migration020.up(db);
});

afterEach(() => {
  db.close();
});

function countRows(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM provision_events').get() as { n: number }).n;
}

describe('migration020', () => {
  it('creates the provision_events table and the ts index', () => {
    // Arrange + Act
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provision_events'")
      .get() as { name: string } | undefined;
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_provision_events_ts'")
      .get() as { name: string } | undefined;

    // Assert
    expect(tbl?.name).toBe('provision_events');
    expect(idx?.name).toBe('idx_provision_events_ts');
  });

  it('is idempotent (CREATE IF NOT EXISTS re-runs cleanly)', () => {
    // Arrange + Act + Assert
    expect(() => migration020.up(db)).not.toThrow();
  });
});

describe('recordProvisionEvent + recentProvisionEvents', () => {
  it('round-trips an event with a domain, mapping creator_id to creatorId', () => {
    // Arrange
    recordProvisionEvent(db, { ts: NOW - 1000, creatorId: 'ag-A', domain: 'trirat.co' });

    // Act
    const recent = recentProvisionEvents(db, NOW, WINDOW);

    // Assert
    expect(recent).toEqual([{ ts: NOW - 1000, creatorId: 'ag-A', domain: 'trirat.co' }]);
  });

  it('stores a missing domain as null', () => {
    // Arrange
    recordProvisionEvent(db, { ts: NOW - 1000, creatorId: 'ag-A' });

    // Act
    const recent = recentProvisionEvents(db, NOW, WINDOW);

    // Assert
    expect(recent).toEqual([{ ts: NOW - 1000, creatorId: 'ag-A', domain: null }]);
  });

  it('returns events oldest-first', () => {
    // Arrange — insert out of order
    recordProvisionEvent(db, { ts: NOW - 1000, creatorId: 'ag-A' });
    recordProvisionEvent(db, { ts: NOW - 3000, creatorId: 'ag-B' });
    recordProvisionEvent(db, { ts: NOW - 2000, creatorId: 'ag-C' });

    // Act
    const recent = recentProvisionEvents(db, NOW, WINDOW);

    // Assert
    expect(recent.map((e) => e.creatorId)).toEqual(['ag-B', 'ag-C', 'ag-A']);
  });

  it('excludes events at or before the exclusive window lower bound', () => {
    // Arrange — boundary = NOW - WINDOW. ts must be > boundary to be returned.
    const boundary = NOW - WINDOW;
    recordProvisionEvent(db, { ts: boundary, creatorId: 'on-bound' }); // excluded
    recordProvisionEvent(db, { ts: boundary - 1, creatorId: 'older' }); // excluded
    recordProvisionEvent(db, { ts: boundary + 1, creatorId: 'in-window' }); // included

    // Act
    const recent = recentProvisionEvents(db, NOW, WINDOW);

    // Assert
    expect(recent.map((e) => e.creatorId)).toEqual(['in-window']);
  });
});

describe('pruneProvisionEvents', () => {
  it('deletes only rows at or older than the keep boundary and returns the count', () => {
    // Arrange — keepMs = WINDOW; cutoff = NOW - WINDOW.
    const cutoff = NOW - WINDOW;
    recordProvisionEvent(db, { ts: cutoff - 10, creatorId: 'old-1' }); // pruned
    recordProvisionEvent(db, { ts: cutoff, creatorId: 'old-2' }); // pruned (inclusive)
    recordProvisionEvent(db, { ts: cutoff + 10, creatorId: 'keep-1' }); // kept

    // Act
    const deleted = pruneProvisionEvents(db, NOW, WINDOW);

    // Assert
    expect(deleted).toBe(2);
    expect(countRows()).toBe(1);
    const remaining = db.prepare('SELECT creator_id FROM provision_events').get() as { creator_id: string };
    expect(remaining.creator_id).toBe('keep-1');
  });

  it('returns 0 when nothing is old enough to prune', () => {
    // Arrange
    recordProvisionEvent(db, { ts: NOW - 1000, creatorId: 'fresh' });

    // Act
    const deleted = pruneProvisionEvents(db, NOW, WINDOW);

    // Assert
    expect(deleted).toBe(0);
    expect(countRows()).toBe(1);
  });
});
