import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { recordDelivery, deliveryCount } from './delivery-tracker.js';

/**
 * The delivery tally MUST cross the process boundary: recordDelivery() runs in
 * the nanoclaw MCP stdio subprocess (the send tools), while deliveryCount() is
 * read in the poll-loop process. These tests pin both the in-process contract
 * and the cross-process visibility that the live nudge false-fire exposed.
 *
 * Each test points NANOCLAW_DELIVERY_TALLY at an isolated temp file so they
 * neither collide with each other nor with the container default (/tmp).
 */
describe('delivery-tracker', () => {
  let dir: string;
  let tally: string;
  const prevEnv = process.env.NANOCLAW_DELIVERY_TALLY;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nanoclaw-tally-'));
    tally = path.join(dir, 'deliveries.tally');
    process.env.NANOCLAW_DELIVERY_TALLY = tally;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.NANOCLAW_DELIVERY_TALLY;
    else process.env.NANOCLAW_DELIVERY_TALLY = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at zero and increments by one per recordDelivery (delta math)', () => {
    expect(deliveryCount()).toBe(0);

    recordDelivery();
    expect(deliveryCount()).toBe(1);

    const baseline = deliveryCount();
    recordDelivery();
    recordDelivery();
    expect(deliveryCount()).toBe(3);
    expect(deliveryCount() - baseline).toBe(2);
  });

  it('returns 0 (no throw) when the tally file does not exist', () => {
    expect(existsSync(tally)).toBe(false);
    expect(deliveryCount()).toBe(0);
  });

  it('sees deliveries recorded in a SEPARATE process (the real bug)', () => {
    // The MCP send tools run in a `bun run mcp-tools/index.ts` subprocess. Prove
    // that a delivery recorded there is visible to this (poll-loop) process by
    // recording N times from a child Bun process pointed at the same tally file,
    // then reading the count here. On the old module-level counter this delta was
    // always 0 from the reader's heap — the exact failure that nudged every send.
    // A temp .ts child (not `bun -e`) sidesteps eval-string + Windows-path quoting.
    const N = 5;
    const modUrl = pathToFileURL(path.resolve(import.meta.dir, 'delivery-tracker.ts')).href;
    const childPath = path.join(dir, 'child.ts');
    writeFileSync(
      childPath,
      `import { recordDelivery } from ${JSON.stringify(modUrl)};\n` +
        `for (let i = 0; i < ${N}; i++) recordDelivery();\n`,
    );

    expect(deliveryCount()).toBe(0);
    const proc = Bun.spawnSync(['bun', 'run', childPath], {
      env: { ...process.env, NANOCLAW_DELIVERY_TALLY: tally },
    });
    expect(proc.stderr.toString()).toBe('');
    expect(proc.success).toBe(true);
    expect(deliveryCount()).toBe(N);
  });
});
