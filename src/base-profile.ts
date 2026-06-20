/**
 * Base agent profile — applied ONCE at agent-group creation.
 *
 * Gives every new hire the §5.11 baseline research capability:
 *   - Exa (web search) + Firecrawl (scrape) MCP servers, run via `npx -y`
 *     (ISOLATED dep trees — co-baking both via `pnpm install -g` dedupes zod to
 *     3.24.4 and crashes firecrawl on `zod/v3`; npx sidesteps it). dev-log/0015.
 *   - Read-only mount of the task-list board (data/tasklist) at
 *     /workspace/extra/tasklist, so the agent can `task_list`.
 *
 * CREATE-ONLY: call from the creation path (create_agent / channel-approval),
 * NEVER from the spawn path (`container-runner.buildMounts`) — re-applying on
 * every spawn would clobber per-agent customization the MD applied later.
 * Still additive + idempotent (only fills gaps; never overwrites an existing
 * server/mount of the same key) as defense-in-depth.
 *
 * Graceful: skips a server when its key is absent from the host env rather than
 * writing a dead empty-key config that fails at runtime. The host gets the keys
 * from a systemd EnvironmentFile (~/agent-tools.env).
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import type { AdditionalMountConfig, McpServerConfig } from './container-config.js';
import { getContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { log } from './log.js';

const EXA_PKG = 'exa-mcp-server@3.2.1';
const FIRECRAWL_PKG = 'firecrawl-mcp@3.21.0';

export function applyBaseProfile(agentGroupId: string): void {
  const row = getContainerConfig(agentGroupId);
  if (!row) {
    log.warn('applyBaseProfile: no container_config row; skipping', { agentGroupId });
    return;
  }

  const applied: string[] = [];

  // --- Search + scrape MCP servers (npx-isolated, key-gated) ---
  const mcp = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  const exaKey = process.env.EXA_API_KEY;
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;

  if (exaKey && !mcp.exa) {
    mcp.exa = {
      command: 'npx',
      args: ['-y', EXA_PKG],
      env: { EXA_API_KEY: exaKey },
      instructions:
        'Exa MCP — live web search. Use web_search_exa for current web/news/company/code results; returns ranked snippets with URLs. Prefer over guessing for time-sensitive or factual lookups.',
    };
    applied.push('mcp:exa');
  }
  if (firecrawlKey && !mcp.firecrawl) {
    mcp.firecrawl = {
      command: 'npx',
      args: ['-y', FIRECRAWL_PKG],
      env: { FIRECRAWL_API_KEY: firecrawlKey },
      instructions:
        'Firecrawl MCP — fetch web pages as clean markdown. Use firecrawl_scrape with a URL to read a page; firecrawl_search to search+scrape in one call.',
    };
    applied.push('mcp:firecrawl');
  }
  if (applied.length > 0) {
    updateContainerConfigJson(agentGroupId, 'mcp_servers', mcp);
  }

  // --- Task-list board (read-only mount) ---
  const mounts = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
  if (!mounts.some((m) => m.containerPath === 'tasklist')) {
    mounts.push({ hostPath: path.join(DATA_DIR, 'tasklist'), containerPath: 'tasklist', readonly: true });
    updateContainerConfigJson(agentGroupId, 'additional_mounts', mounts);
    applied.push('mount:tasklist');
  }

  log.info('Applied base agent profile', {
    agentGroupId,
    applied: applied.length > 0 ? applied : 'nothing (keys absent or already set)',
  });
}
