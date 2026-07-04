import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

function seedAgentDestination(name: string, displayName: string, agentGroupId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'agent', NULL, NULL, ?)`,
    )
    .run(name, displayName, agentGroupId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes send_message usage for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('send_message({ to: "name"');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes send_message and default-routing instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('send_message({ to: "name"');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });
});

describe('buildSystemPromptAddendum — send_message example', () => {
  it('includes a worked send_message example for the inbound destination', () => {
    seedDestination('telegram', 'Telegram', 'telegram', 'chat-1');
    const prompt = buildSystemPromptAddendum('CoS');
    expect(prompt).toContain('Example — replying to an inbound message');
    expect(prompt).toContain('send_message({ to: "telegram"');
    // The wrapper protocol is gone — no "must be wrapped" instruction remains.
    expect(prompt).not.toContain('Wrap each delivered message');
  });
});

describe('buildSystemPromptAddendum — primary user block', () => {
  it('emits a "Your user" block when primaryUser is present', () => {
    seedDestination('user', 'alice@trirat.co', 'cli', 'web:google:123');
    const prompt = buildSystemPromptAddendum('CoS', {
      name: 'alice@trirat.co',
      email: 'alice@trirat.co',
      destination: 'user',
    });
    expect(prompt).toContain('## Your user');
    expect(prompt).toContain('Your primary user is alice@trirat.co (alice@trirat.co)');
    expect(prompt).toContain(`to:'user'`);
    expect(prompt).toContain('Send reports and files to them, NOT to other agents.');
    expect(prompt).toContain('`parent` and any other agents are colleagues, not your user.');
  });

  it('omits the email parens when no email is derivable', () => {
    seedDestination('user', 'Bob', 'cli', 'web:google:456');
    const prompt = buildSystemPromptAddendum('CoS', { name: 'Bob', destination: 'user' });
    expect(prompt).toContain('Your primary user is Bob.');
    expect(prompt).not.toContain('Bob (');
  });

  it('omits the "Your user" block entirely when primaryUser is absent', () => {
    seedDestination('parent', 'Chief of Staff', 'cli', 'web:google:789');
    const prompt = buildSystemPromptAddendum('CoS');
    expect(prompt).not.toContain('## Your user');
    expect(prompt).not.toContain('Your primary user is');
  });

  it('forcefully instructs persisting durable facts to /workspace/agent/ in the same turn', () => {
    seedDestination('user', 'alice@trirat.co', 'cli', 'web:google:123');
    const prompt = buildSystemPromptAddendum('CoS', {
      name: 'alice@trirat.co',
      email: 'alice@trirat.co',
      destination: 'user',
    });
    expect(prompt).toContain('/workspace/agent/');
    expect(prompt).toContain('same turn');
    expect(prompt).toContain('Acknowledging');
    expect(prompt).toContain('is NOT enough');
  });

  it('includes the persist-in-the-same-turn rule even when no primaryUser is resolved', () => {
    seedDestination('parent', 'Chief of Staff', 'cli', 'web:google:789');
    const prompt = buildSystemPromptAddendum('CoS');
    expect(prompt).toContain('/workspace/agent/');
    expect(prompt).toContain('same turn');
    expect(prompt).toContain('is NOT enough');
  });
});

describe('buildSystemPromptAddendum — people vs. agents split', () => {
  it('splits mixed destinations into "Your people" and "Other agents" sections', () => {
    seedDestination('user', 'alice@trirat.co', 'cli', 'web:google:123');
    seedAgentDestination('parent', 'Chief of Staff', 'ag-cos');

    const prompt = buildSystemPromptAddendum('Alice-agent');

    expect(prompt).toContain('**Your people:**');
    expect(prompt).toContain('- `user` (alice@trirat.co)');
    expect(prompt).toContain("**Other agents (colleagues — don't send your user's files here):**");
    expect(prompt).toContain('- `parent` (Chief of Staff)');
    // The people heading must precede the agents heading (people surfaced first).
    expect(prompt.indexOf('**Your people:**')).toBeLessThan(
      prompt.indexOf("**Other agents (colleagues — don't send your user's files here):**"),
    );
  });

  it('omits the "Other agents" heading when there are no agent-type destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('**Your people:**');
    expect(prompt).not.toContain('**Other agents');
  });

  it('omits the "Your people" heading when there are no channel-type destinations', () => {
    seedAgentDestination('parent', 'Chief of Staff', 'ag-cos');
    seedAgentDestination('worker-1', 'Worker One', 'ag-w1');

    const prompt = buildSystemPromptAddendum('Worker');

    expect(prompt).not.toContain('**Your people:**');
    expect(prompt).toContain("**Other agents (colleagues — don't send your user's files here):**");
    expect(prompt).toContain('- `parent` (Chief of Staff)');
    expect(prompt).toContain('- `worker-1` (Worker One)');
  });
});
