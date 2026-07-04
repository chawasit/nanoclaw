/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getChildAgentGroupIds, getDestinations } from './modules/agent-to-agent/db/agent-destinations.js';
import { getMembers } from './modules/permissions/db/agent-group-members.js';
import { getUser } from './modules/permissions/db/users.js';
import { applyLeaderWorkspaceMounts } from './leader-mounts.js';
import { disallowedToolsForRole } from './leader-tools.js';
import { applyAutoCompactWindow } from './context-window.js';
import { applyProxyEnv, shouldBlockAnthropicForProxy } from './proxy-env.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  env?: Record<string, string>;
  blockedHosts?: string[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  /** Tool names to DISALLOW for this agent (leader-gated; dev-log/0057). */
  disallowedTools?: string[];
  /** The agent's bound human (agent_group_members), surfaced structurally — see resolvePrimaryUser. */
  primaryUser?: { name: string; email?: string; destination: string };
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    env: JSON.parse(row.env) as Record<string, string>,
    blockedHosts: JSON.parse(row.blocked_hosts) as string[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Resolve the agent's primary human — the earliest `agent_group_members` row
 * (D5 one-human-one-agent means there's normally at most one) — plus the
 * local_name of whichever channel destination is their reply lane (the `cli`
 * web lane wired by `wireWebLane`/`create_agent`). Returns undefined for
 * agents with no bound human (e.g. internal/company agents) or no resolvable
 * reply lane, so container.json simply omits the field.
 */
function resolvePrimaryUser(agentGroupId: string): ContainerConfig['primaryUser'] {
  const [firstMember] = getMembers(agentGroupId);
  if (!firstMember) return undefined;

  const human = getUser(firstMember.user_id);
  if (!human) return undefined;

  const humanLane = getDestinations(agentGroupId).find((d) => {
    if (d.target_type !== 'channel') return false;
    return getMessagingGroup(d.target_id)?.channel_type === 'cli';
  });
  if (!humanLane) return undefined;

  const email = human.display_name?.includes('@') ? human.display_name : undefined;
  return { name: human.display_name ?? human.id, email, destination: humanLane.local_name };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  // Spawn-time workspace overlay (dev-log/0067; supersedes dev-log/0048's per-agent
  // work + team/<report> mounts). Computes leadership from the LIVE org graph for
  // vault RW promotion (upgrade-only) and strips the retired per-agent `work` mount.
  // Recomputed every spawn so a reorg just changes the mounts next spawn (no file
  // moves). No-op when COMPANY_NAS_PATH is unset.
  const reportIds = getChildAgentGroupIds(agentGroupId);
  const isLeader = reportIds.length > 0 || row.cli_scope === 'global';
  config.additionalMounts = applyLeaderWorkspaceMounts(config.additionalMounts, {
    nasPath: process.env.COMPANY_NAS_PATH,
    isLeader,
  });

  // Durable task-board WRITE tools are manager-only; workers plan with their own
  // TodoWrite + report_status (SOP). Gate per leadership, recomputed each spawn.
  config.disallowedTools = disallowedToolsForRole(isLeader);

  // Surface the bound human structurally (agent "primary user" identity —
  // fixes the misroute where an agent sent a report to `parent` instead of
  // its owner). Recomputed every spawn; absent for agents with no bound human.
  config.primaryUser = resolvePrimaryUser(agentGroupId);

  // Auto-compact window follows the model tier each spawn (cloud models hold far
  // more than the 165K default; local gemma must stay at 165K). Explicit env wins.
  config.env = applyAutoCompactWindow(config.env, config.model);

  // Auto-inject the LiteLLM-proxy env for proxy-routed models (glm/minimax/gemini/gpt)
  // so a proxy agent created with an empty env can actually reach the proxy instead of
  // being dead-on-arrival (dev-log/0068). Env-gated on the spine's own proxy config;
  // explicit per-agent ANTHROPIC_BASE_URL always wins (gemma-on-ampere untouched).
  const proxyHost = {
    baseUrl: process.env.NANOCLAW_PROXY_BASE_URL,
    apiKey: process.env.NANOCLAW_PROXY_API_KEY,
  };
  if (shouldBlockAnthropicForProxy(config.env, config.model, proxyHost)) {
    config.env = applyProxyEnv(config.env, config.model, proxyHost);
    const blocked = new Set(config.blockedHosts ?? []);
    blocked.add('api.anthropic.com');
    config.blockedHosts = [...blocked];
  }

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
