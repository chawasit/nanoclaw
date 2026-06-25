/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage, sendFile } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});


describe('send_message / send_file - content-keyed idempotency (CoS duplicate-send bug)', () => {
  function seedChannelDest(): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('owner', 'Owner', 'channel', 'telegram', 'telegram:1030273932', NULL)`,
      )
      .run();
  }

  it('first send is queued and the result names the resolved destination', async () => {
    seedChannelDest();
    const res = await sendMessage.handler({ to: 'owner', text: 'hi' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('queued for delivery to telegram:telegram:1030273932');
    expect(text).not.toContain('Message sent');
  });

  it('a 2nd identical send_message is skipped, not re-queued', async () => {
    seedChannelDest();
    await sendMessage.handler({ to: 'owner', text: 'morning digest' });
    const before = getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };

    const res = await sendMessage.handler({ to: 'owner', text: 'morning digest' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('skipped');
    expect(text).toContain('telegram:telegram:1030273932');
    expect(text).toContain('already delivered');

    const after = getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };
    expect(after.c).toBe(before.c); // no new row written for the dup
  });

  it('distinct content to the same destination is NOT skipped', async () => {
    seedChannelDest();
    await sendMessage.handler({ to: 'owner', text: 'first' });
    const res = await sendMessage.handler({ to: 'owner', text: 'second' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('queued for delivery');
    expect(text).not.toContain('skipped');
    const rows = getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };
    expect(rows.c).toBe(2);
  });
});


describe('send_file - content-keyed idempotency (the literal CoS bug path)', () => {
  let tmpFile = '';

  function seedChannelDest(): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('owner', 'Owner', 'channel', 'telegram', 'telegram:1030273932', NULL)`,
      )
      .run();
  }

  it('an identical send_file is skipped (no new row, no outbox copy) when a matching recent row exists', async () => {
    seedChannelDest();
    tmpFile = path.join(os.tmpdir(), `sim-digest-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, 'PDFDATA');

    // Seed the "1st send" row directly with the exact content send_file builds
    // ({ text:'', files:[filename] }). This avoids depending on /workspace/outbox
    // existing in the host test env; the dedup CHECK + skip path runs before any
    // file copy, which is exactly what we assert here.
    const filename = 'digest.pdf';
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES ('seed-1', 1, NULL, datetime('now'), 'chat', 'telegram:1030273932', 'telegram', NULL, ?)`,
      )
      .run(JSON.stringify({ text: '', files: [filename] }));

    const before = getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };

    const r = await sendFile.handler({ to: 'owner', path: tmpFile, filename });
    const t = (r.content[0] as { text: string }).text;
    expect(t).toContain('skipped');
    expect(t).toContain('telegram:telegram:1030273932');
    expect(t).toContain('already delivered');

    const after = getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number };
    expect(after.c).toBe(before.c); // dup wrote no new outbound row (skip ran before any copy)

    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });
});

/**
 * Destination resolution on the TOOL path. Under the send_message-only
 * protocol (dev-log/0083) the tool is the sole delivery path, so the routing
 * the old result-text <message> wrapper used to do (and which the integration
 * e2e suite used to cover) now lives here. The big behavioural improvement: an
 * unknown destination returns an ERROR to the agent instead of being silently
 * dropped — that error is the safety net the old wrapper path lacked.
 */
describe('send_message — destination resolution (tool path; replaces wrapper routing)', () => {
  function seedChannel(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  it('resolves a named destination and stamps its routing on the outbound row', async () => {
    seedChannel('discord-test', 'discord', 'chan-1');
    await sendMessage.handler({ to: 'discord-test', text: 'hi' });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].platform_id).toBe('chan-1');
    expect(JSON.parse(out[0].content).text).toBe('hi');
  });

  it('returns an error (writing NO row) for an unknown destination — the replacement for the old silent wrapper drop', async () => {
    seedChannel('discord-test', 'discord', 'chan-1');
    const res = await sendMessage.handler({ to: 'nonexistent', text: 'dropped?' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Unknown destination "nonexistent"');
    // Lists the known destinations so the agent can correct itself.
    expect(text).toContain('discord-test');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('with multiple destinations and no `to`, asks the agent to specify one (no row)', async () => {
    // beforeEach seeded 'peer'; add a 2nd so there's ambiguity and no session default.
    seedChannel('discord-test', 'discord', 'chan-1');
    const res = await sendMessage.handler({ text: 'to whom?' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('specify');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('with a single destination and no `to`, delivers to it', async () => {
    // Only the beforeEach 'peer' (agent) destination exists.
    await sendMessage.handler({ text: 'sole reply' });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-peer');
  });
});
