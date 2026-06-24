/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

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
