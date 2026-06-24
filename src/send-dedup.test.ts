import { describe, it, expect, beforeEach } from 'vitest';

import { isDuplicateSend, recordSend, sendDedupKey, hashSendContent, _resetSendDedup } from './send-dedup.js';

const CH = 'telegram';
const PID = 'telegram:1030273932';
const PDF = JSON.stringify({ text: '', files: ['morning-digest.pdf'] });

beforeEach(() => {
  _resetSendDedup();
});

describe('hashSendContent / sendDedupKey', () => {
  it('hashes identical content to the same digest', () => {
    expect(hashSendContent(PDF)).toBe(hashSendContent(PDF));
  });

  it('hashes different content differently', () => {
    expect(hashSendContent('a')).not.toBe(hashSendContent('b'));
  });

  it('keys differ by channel, platform, and content; thread_id is not part of the key', () => {
    const k1 = sendDedupKey(CH, PID, PDF);
    expect(k1).toBe(sendDedupKey(CH, PID, PDF));
    expect(k1).not.toBe(sendDedupKey(CH, 'telegram:999', PDF));
    expect(k1).not.toBe(sendDedupKey('discord', PID, PDF));
    expect(k1).not.toBe(sendDedupKey(CH, PID, JSON.stringify({ text: 'x' })));
  });
});

describe('isDuplicateSend — the CoS 10x-PDF burst', () => {
  it('first send is not a duplicate', () => {
    expect(isDuplicateSend(CH, PID, PDF, 1_000)).toBe(false);
  });

  it('drops an exact duplicate within the window', () => {
    recordSend(CH, PID, PDF, 1_000);
    // 9 rapid re-issues over the next ~5s — all dups.
    expect(isDuplicateSend(CH, PID, PDF, 1_500)).toBe(true);
    expect(isDuplicateSend(CH, PID, PDF, 6_000)).toBe(true);
  });

  it('allows the same content again AFTER the window elapses', () => {
    recordSend(CH, PID, PDF, 1_000);
    expect(isDuplicateSend(CH, PID, PDF, 1_000 + 60_000)).toBe(false); // exactly window: not < window
    expect(isDuplicateSend(CH, PID, PDF, 1_000 + 61_000)).toBe(false);
  });

  it('allows distinct content within the window', () => {
    recordSend(CH, PID, PDF, 1_000);
    const other = JSON.stringify({ text: '', files: ['weekly-report.pdf'] });
    expect(isDuplicateSend(CH, PID, other, 1_500)).toBe(false);
  });

  it('allows the same content to a different destination within the window', () => {
    recordSend(CH, PID, PDF, 1_000);
    expect(isDuplicateSend(CH, 'telegram:999', PDF, 1_500)).toBe(false);
    expect(isDuplicateSend('discord', PID, PDF, 1_500)).toBe(false);
  });

  it('record-AFTER semantics: a never-recorded (failed) send is not suppressed on retry', () => {
    // Simulate a failed first deliver: isDuplicateSend checked, deliver threw,
    // recordSend NOT called. The retry must still be allowed.
    expect(isDuplicateSend(CH, PID, PDF, 1_000)).toBe(false);
    expect(isDuplicateSend(CH, PID, PDF, 2_000)).toBe(false); // still allowed — never recorded
  });

  it('a custom window of 0 disables suppression', () => {
    recordSend(CH, PID, PDF, 1_000);
    expect(isDuplicateSend(CH, PID, PDF, 1_001, 0)).toBe(false);
  });
});
