import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { recordDelivery } from './delivery-tracker.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isCorruptionError, looksLikeMalformedMessageAttempt, processQuery } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal undelivered result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no send call' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('nothing was delivered');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('result-text <message> wrappers are no longer delivered (hard-disabled)', () => {
  function seedDest(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  function oneShot(text: string) {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' } as ProviderEvent;
      yield { type: 'result', text } as ProviderEvent;
    }
    return {
      pushes,
      query: { push: (m: string) => { pushes.push(m); }, end: () => {}, events: events(), abort: () => {} } as AgentQuery,
    };
  }
  const ROUTING = { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' };

  it('a clean <message> block in result text delivers NOTHING and nudges toward send_message', async () => {
    seedDest('discord-main', 'discord', 'chan-1');
    const { query, pushes } = oneShot('<message to="discord-main">All set — report delivered.</message>');
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    // The wrapper path is gone — no outbound row is written from result text.
    expect(getUndeliveredMessages()).toHaveLength(0);
    // … and the agent is told to use send_message instead.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('no longer a delivery channel');
  });

  it('a nested-opener reasoning leak also delivers nothing and nudges', async () => {
    seedDest('discord-main', 'discord', 'chan-1');
    const leak =
      '<message to="discord-main">Let me reply. I will wrap in <message to="discord-main">. ' +
      'End turn. <message to="discord-main"> the real text </message>';
    const { query, pushes } = oneShot(leak);
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('no longer a delivery channel');
  });
});

describe('looksLikeMalformedMessageAttempt', () => {
  it('detects the live failure: garbled tag name + wrong attribute', () => {
    // The actual CoS morning-brief tag (glm): <messaggio a="telegram">…</message>
    expect(looksLikeMalformedMessageAttempt('<messaggio a="telegram">brief…</message>')).toBe(true);
  });

  it('detects unquoted / unclosed openers and stray closes', () => {
    expect(looksLikeMalformedMessageAttempt('<message to=telegram>hi</message>')).toBe(true); // no quotes
    expect(looksLikeMalformedMessageAttempt('<message to="telegram" oops')).toBe(true); // unclosed open
    expect(looksLikeMalformedMessageAttempt('some text </message>')).toBe(true); // stray close
    expect(looksLikeMalformedMessageAttempt('<msg to="telegram">hi</msg>')).toBe(true); // abbreviated
  });

  it('is false for plain prose with no message-tag token', () => {
    expect(looksLikeMalformedMessageAttempt('I will send a message to ik shortly.')).toBe(false);
    expect(looksLikeMalformedMessageAttempt('bare text, no envelope')).toBe(false);
    expect(looksLikeMalformedMessageAttempt('')).toBe(false);
  });
});

describe('send_message nudge (undelivered turns)', () => {
  function seedDest(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  function oneShot(text: string) {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' } as ProviderEvent;
      yield { type: 'result', text } as ProviderEvent;
    }
    return {
      pushes,
      query: { push: (m: string) => { pushes.push(m); }, end: () => {}, events: events(), abort: () => {} } as AgentQuery,
    };
  }
  const ROUTING = { platformId: 'chan-1', channelType: 'telegram', threadId: null, inReplyTo: 'm1' };

  it('points a garbled <message> tag at send_message (wrapper nudge, not generic)', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    // The exact live shape: garbled open tag, valid close.
    const { query, pushes } = oneShot('<messaggio a="telegram">\nik — morning brief…\n</message>');
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('no longer a delivery channel');
    expect(pushes[0]).toContain('send_message');
  });

  it('uses the generic send_message nudge for plain unwrapped prose', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    const { query, pushes } = oneShot('ik — here is the brief, all clear.');
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('nothing was delivered');
    expect(pushes[0]).not.toContain('no longer a delivery channel');
  });

  it('a turn with only <internal> scratchpad is NOT nudged (pure thinking, no reply)', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    const { query, pushes } = oneShot('<internal>thinking… no reply needed this turn</internal>');
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it('a turn emitting [[SLEEP_SUMMARY_COMPLETE]] is NOT nudged (intentional EOD completion, no send)', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    const { query, pushes } = oneShot('Memory consolidated and handoff.md written.\n[[SLEEP_SUMMARY_COMPLETE]]');
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });
});

describe('delivered turn (send_message) is not nudged', () => {
  function seedDest(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  const ROUTING = { platformId: 'chan-1', channelType: 'telegram', threadId: null, inReplyTo: 'm1' };

  it('when the agent calls send_message mid-turn, no nudge fires even with trailing text', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    const pushes: string[] = [];
    // Simulate the agent: between init and result it calls send_message — which
    // writes an outbound row AND records a delivery — then emits trailing prose.
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' } as ProviderEvent;
      writeMessageOut({
        id: 'out-sim-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'telegram',
        thread_id: null,
        content: JSON.stringify({ text: 'delivered via tool' }),
      });
      recordDelivery();
      yield { type: 'result', text: 'ok, sent it.' } as ProviderEvent;
    }
    const query = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    } as AgentQuery;
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    // The delivery counted → no nudge, and the tool's row is present.
    expect(pushes).toHaveLength(0);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered via tool');
  });

  it('a plain-text reply AFTER an earlier delivery IS nudged now (re-arming latch, dev-log/0189)', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    const pushes: string[] = [];
    // The owner-reported live gemma-4 CoS pattern (2026-07-05): the agent delivers
    // an early reply via send_message, then on a LATER turn answers in plain text
    // and never calls the send tool. Under the OLD stream-scoped suppression
    // (`deliveredThisStream`, dev-log/0135) that later reply was NEVER nudged and
    // the user's chat went dark. The re-arming latch fixes this: a delivery
    // re-arms the nudge, so the next dry turn IS caught. Accepted, bounded
    // trade-off: this also re-admits the dev-log/0135 trailing-"Done" false
    // positive — one non-coercive nudge, capped by MAX_NUDGES_PER_STREAM.
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' } as ProviderEvent;
      writeMessageOut({
        id: 'out-live-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'telegram',
        thread_id: null,
        content: JSON.stringify({ text: 'the real reply' }),
      });
      recordDelivery();
      yield { type: 'result', text: 'Delivered (id 29).' } as ProviderEvent;
      yield { type: 'result', text: 'here is the next answer, undelivered' } as ProviderEvent;
    }
    const query = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    } as AgentQuery;
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    // The delivery re-armed the nudge → the later undelivered reply is caught.
    expect(pushes.some((p) => p.includes('nothing was delivered'))).toBe(true);
  });

  it('caps nudges per stream (MAX_NUDGES_PER_STREAM) so a flaky model cannot loop into OOM', async () => {
    seedDest('telegram', 'telegram', 'chan-1');
    const pushes: string[] = [];
    // Worst case: 8 deliver→undeliver cycles. Each delivery re-arms the latch, so
    // without a cap every cycle would nudge (8×). The absolute per-stream cap (5)
    // bounds it — the backstop against a nudge<->retext loop feeding the code-137
    // OOM seen with gemma.
    const CYCLES = 8;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' } as ProviderEvent;
      for (let i = 0; i < CYCLES; i++) {
        writeMessageOut({
          id: `out-cap-${i}`,
          kind: 'chat',
          platform_id: 'chan-1',
          channel_type: 'telegram',
          thread_id: null,
          content: JSON.stringify({ text: `delivery ${i}` }),
        });
        recordDelivery();
        yield { type: 'result', text: `sent ${i}` } as ProviderEvent; // re-arms
        yield { type: 'result', text: `undelivered reply ${i}` } as ProviderEvent; // nudge candidate
      }
    }
    const query = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    } as AgentQuery;
    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    const nudges = pushes.filter((p) => p.includes('nothing was delivered')).length;
    // Capped at 5 despite 8 undelivered turns — proves the OOM backstop holds.
    expect(nudges).toBe(5);
  });
});
