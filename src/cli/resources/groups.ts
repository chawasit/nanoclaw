import type { McpServerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { cascadeDeleteAgentGroup } from './group-cascade.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import type { ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/** Validate the `mcpServers` request shape for `groups-config-update-mcp` — a plain
 * object mapping server name to `McpServerConfig` (command required; args/env/instructions optional). */
function validateMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mcpServers must be an object mapping server name to { command, args?, env?, instructions? }');
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`mcpServers.${name} must be an object`);
    }
    const v = value as Record<string, unknown>;
    if (typeof v.command !== 'string' || !v.command) {
      throw new Error(`mcpServers.${name}.command is required and must be a string`);
    }
    if (v.args !== undefined && !(Array.isArray(v.args) && v.args.every((a) => typeof a === 'string'))) {
      throw new Error(`mcpServers.${name}.args must be an array of strings`);
    }
    if (v.env !== undefined && (typeof v.env !== 'object' || Array.isArray(v.env) || v.env === null)) {
      throw new Error(`mcpServers.${name}.env must be an object`);
    }
    if (v.instructions !== undefined && typeof v.instructions !== 'string') {
      throw new Error(`mcpServers.${name}.instructions must be a string`);
    }
    out[name] = {
      command: v.command,
      ...(v.args !== undefined ? { args: v.args as string[] } : {}),
      ...(v.env !== undefined ? { env: v.env as Record<string, string> } : {}),
      ...(v.instructions !== undefined ? { instructions: v.instructions as string } : {}),
    };
  }
  return out;
}

/**
 * Resolve MCP env values at write time (the secret boundary). Circle's catalog never
 * holds secret values — its `groups-config-update-mcp` request carries the env-key
 * NAMES with BLANK values; we fill each blank from the host's own `process.env`,
 * keeping only keys that are actually set (mirrors `applyBaseProfile`'s gating). A
 * caller that supplies a non-blank value (base-profile, tests, a host-side script)
 * has it passed through untouched — so this is backward-compatible with literal
 * callers and additive for Circle's name-only convention.
 */
function resolveMcpServerEnv(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.env || Object.keys(cfg.env).length === 0) {
      out[name] = cfg;
      continue;
    }
    const resolved: Record<string, string> = {};
    for (const [key, provided] of Object.entries(cfg.env)) {
      if (provided && provided.length > 0) {
        resolved[key] = provided; // literal supplied by a host caller — keep as-is
      } else {
        const hostVal = process.env[key]; // Circle sent a blank → resolve from host env
        if (hostVal) resolved[key] = hostVal;
      }
    }
    out[name] = { ...cfg, env: resolved };
  }
  return out;
}

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    updated_at: row.updated_at,
  };
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `delete` is intentionally not in `operations` — the generic single-table
  // DELETE violates FK constraints (see #2525). The cascading handler is
  // provided as `customOperations.delete` below.
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  customOperations: {
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
        if (!exists) throw new Error(`group not found: ${id}`);

        // Single authoritative FK-ordered cascade (shared with Circle M05).
        // Runs in one transaction so a missed FK rolls the whole thing back;
        // `removed` counts come from each DELETE's `changes`.
        const removed = cascadeDeleteAgentGroup(db, id);

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message) {
            writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? () => {
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and any of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt' | 'cli_scope'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope',
          );
        }

        updateContainerConfigScalars(id, updates);

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config update-env': {
      access: 'approval',
      description:
        'Merge env vars into a group container config, preserving untouched existing keys — the seam a ' +
        'sibling service (Circle M16) calls over ncl.sock to inject a per-agent LiteLLM virtual key. ' +
        'Requires `ncl groups restart` to take effect. Use --id <group-id> --env <object> [--blockedHosts <array>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const env = args.env as Record<string, string> | undefined;
        if (!env || typeof env !== 'object' || Object.keys(env).length === 0) {
          throw new Error('--env is required');
        }

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        // MERGE, never overwrite — existing keys survive unless the patch overrides them.
        const existingEnv = JSON.parse(row.env) as Record<string, string>;
        const mergedEnv = { ...existingEnv, ...env };
        updateContainerConfigJson(id, 'env', mergedEnv);

        const blockedHosts = args.blockedHosts as string[] | undefined;
        if (blockedHosts !== undefined) {
          updateContainerConfigJson(id, 'blocked_hosts', blockedHosts);
        }

        // Echo keys, not secret values, back over the wire.
        return {
          agent_group_id: id,
          updated: true,
          env_keys: Object.keys(mergedEnv),
          blocked_hosts: blockedHosts ?? (JSON.parse(getContainerConfig(id)!.blocked_hosts) as string[]),
        };
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>] ' +
        '[--instructions <text>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const instructions = args.instructions as string | undefined;
        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        servers[name] = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
          ...(instructions ? { instructions } : {}),
        };
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { added: name, servers };
      },
    },
    'config update-skills': {
      access: 'open', // host-only enforced inline below — same access class as create_agent/erase_user
      description:
        'MCP-tools/skills mgmt seam: set the group\'s skill selection (desired-state replace; upserts the ' +
        'container_configs row if missing). Host-only. Does NOT restart the container — applies on the ' +
        'agent\'s next natural respawn. Use --groupId <id> --skills <"all"|json-string-array>.',
      handler: async (args, ctx) => {
        if (ctx.caller !== 'host') throw new Error('host-only command');
        const groupId = args.groupId as string;
        if (!groupId) throw new Error('groupId is required');
        if (!getAgentGroup(groupId)) throw new Error(`group not found: ${groupId}`);

        const skills = args.skills;
        if (skills !== 'all' && !(Array.isArray(skills) && skills.every((s) => typeof s === 'string'))) {
          throw new Error('skills must be "all" or an array of strings');
        }

        ensureContainerConfig(groupId);
        updateContainerConfigJson(groupId, 'skills', skills);

        return { groupId, skills };
      },
    },
    'config update-mcp': {
      access: 'open', // host-only enforced inline below — same access class as create_agent/erase_user
      description:
        'MCP-tools/skills mgmt seam: REPLACE the group\'s mcp_servers map wholesale (desired-state, incl. each ' +
        'server\'s optional `instructions`; upserts the container_configs row if missing). Host-only. Does NOT ' +
        'restart the container — applies on the agent\'s next natural respawn. Use --groupId <id> --mcpServers <json-object>.',
      handler: async (args, ctx) => {
        if (ctx.caller !== 'host') throw new Error('host-only command');
        const groupId = args.groupId as string;
        if (!groupId) throw new Error('groupId is required');
        if (!getAgentGroup(groupId)) throw new Error(`group not found: ${groupId}`);

        const mcpServers = resolveMcpServerEnv(validateMcpServers(args.mcpServers));

        ensureContainerConfig(groupId);
        updateContainerConfigJson(groupId, 'mcp_servers', mcpServers);

        return { groupId, servers: Object.keys(mcpServers) };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { removed: name };
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }

        return {
          added: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          updateContainerConfigJson(id, 'packages_npm', filtered);
        }

        return {
          removed: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
  },
});
