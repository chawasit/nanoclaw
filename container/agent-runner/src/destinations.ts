/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import type { PrimaryUser } from './config.js';
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, primaryUser?: PrimaryUser): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  if (primaryUser) {
    sections.push(buildPrimaryUserSection(primaryUser));
  }

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

/**
 * Surface the agent's bound human structurally — this is who reports/files
 * should go to by default, not `parent` or any other agent (dev-log: the
 * chawanrat misroute, a report sent to `parent` instead of the human owner).
 */
function buildPrimaryUserSection(primaryUser: PrimaryUser): string {
  const contact = primaryUser.email ? `${primaryUser.name} (${primaryUser.email})` : primaryUser.name;
  return [
    '## Your user',
    '',
    `Your primary user is ${contact}. Reply to them by default — omit \`to\`, or use \`to:'${primaryUser.destination}'\`. Send reports and files to them, NOT to other agents. \`parent\` and any other agents are colleagues, not your user.`,
  ].join('\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`Your destination is \`${d.name}\`${label}.`, '');
  } else {
    lines.push('You can send messages to the following destinations:', '');
    const people = all.filter((d) => d.type === 'channel');
    const agents = all.filter((d) => d.type === 'agent');
    const pushGroup = (heading: string, group: DestinationEntry[]) => {
      if (group.length === 0) return;
      lines.push(heading, '');
      for (const d of group) {
        const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
        lines.push(`- \`${d.name}\`${label}`);
      }
      lines.push('');
    };
    pushGroup('**Your people:**', people);
    pushGroup("**Other agents (colleagues — don't send your user's files here):**", agents);
  }
  lines.push(
    'To send anything you MUST call the `send_message` tool — `send_message({ to: "name", text: "…" })` (use `send_file` for files). This is the ONLY way your words reach a destination: plain text in your reply, and anything inside `<message>…</message>` or `<internal>…</internal>` tags, is scratchpad — logged, never delivered.',
  );
  lines.push('');
  const exampleName = all[0].name;
  lines.push(
    `**Example — replying to an inbound message.** You received \`<message id="42" from="${exampleName}" sender="alex" time="…">what's the status?</message>\`. To reply, call \`send_message({ to: "${exampleName}", text: "All set — sending the report now." })\`. Writing the answer as plain text — or wrapping it in \`<message>\` tags — delivers nothing.`,
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute — pass that name as `to`). Pick a different destination when the request asks for it (e.g., "tell Laura that…"). If you have a single destination, `to` is optional.',
  );
  lines.push('');
  lines.push(
    'Each `send_message` / `send_file` call lands as its own message in the conversation — send a quick acknowledgment ("on it") before a slow tool call, then the result when done, rather than combining them. A send returns a confirmation; if it returns "already delivered / no retry needed," do NOT send it again — trust the confirmation.',
  );
  return lines.join('\n');
}
