/**
 * Base agent profile — applied ONCE at agent-group creation.
 *
 * Gives every new hire the §5.11 baseline:
 *   - Exa (web search) + Firecrawl (scrape) MCP servers, run via `npx -y`
 *     (ISOLATED dep trees — co-baking both via `pnpm install -g` dedupes zod to
 *     3.24.4 and crashes firecrawl on `zod/v3`; npx sidesteps it). dev-log/0015.
 *   - Read-only mount of the task-list board (data/tasklist) at
 *     /workspace/extra/tasklist, so the agent can `task_list`.
 *   - Read-only mount of the SOP vault (COMPANY_VAULT_PATH) at /workspace/extra/sop
 *     when configured — governance, since base-agent-contract requires consulting
 *     SOPs (qa-report/0002 #5). Graceful: skipped if COMPANY_VAULT_PATH is unset.
 *
 * CREATE-ONLY: call from the creation path (create_agent / channel-approval),
 * NEVER from the spawn path (`container-runner.buildMounts`) — re-applying on
 * every spawn would clobber per-agent customization the MD applied later.
 * Still additive + idempotent (only fills gaps; never overwrites an existing
 * server/mount of the same key) as defense-in-depth.
 *
 * Graceful: skips a server when its key is absent from the host env rather than
 * writing a dead empty-key config that fails at runtime. The host gets the keys
 * (and COMPANY_VAULT_PATH) from a systemd EnvironmentFile (~/agent-tools.env).
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

  // --- Read-only mounts: task board (always) + SOP vault (governance; qa-report/0002 #5) ---
  const mounts = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
  let mountsChanged = false;
  const ensureMount = (hostPath: string | undefined, containerPath: string): void => {
    if (hostPath && !mounts.some((m) => m.containerPath === containerPath)) {
      mounts.push({ hostPath, containerPath, readonly: true });
      applied.push(`mount:${containerPath}`);
      mountsChanged = true;
    }
  };
  ensureMount(path.join(DATA_DIR, 'tasklist'), 'tasklist');
  // SOP vault is governance, not discretionary (base-agent-contract requires it).
  // Graceful: skipped if COMPANY_VAULT_PATH is unset, like the API keys.
  ensureMount(process.env.COMPANY_VAULT_PATH, 'sop');
  if (mountsChanged) {
    updateContainerConfigJson(agentGroupId, 'additional_mounts', mounts);
  }

  // --- Local-LLM-only default (opt-in via NANOCLAW_LOCAL_LLM_ONLY) ---
  // For test/sandbox instances: pin every new hire to a local Anthropic-compatible
  // LLM endpoint (e.g. an Ollama/llama.cpp host) so spawns never spend on the cloud
  // vault key. Sets the base-URL override + a dummy key + NO_PROXY for the endpoint
  // host, and blocks api.anthropic.com. Additive/idempotent; never overrides an
  // already-set base URL. Inert unless the flag is set (production never sets it).
  if (process.env.NANOCLAW_LOCAL_LLM_ONLY) {
    const baseUrl = process.env.NANOCLAW_LOCAL_BASE_URL || 'http://192.168.1.31:11434';
    const llmHost = new URL(baseUrl).hostname;
    const env = JSON.parse(row.env || '{}') as Record<string, string>;
    if (!env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.ANTHROPIC_API_KEY = 'ollama';
      const noProxy = new Set((env.NO_PROXY || '').split(',').filter(Boolean));
      noProxy.add(llmHost);
      env.NO_PROXY = [...noProxy].join(',');
      env.no_proxy = env.NO_PROXY;
      updateContainerConfigJson(agentGroupId, 'env', env);
      applied.push('local-llm:env');
    }
    const blocked = JSON.parse(row.blocked_hosts || '[]') as string[];
    if (!blocked.includes('api.anthropic.com')) {
      blocked.push('api.anthropic.com');
      updateContainerConfigJson(agentGroupId, 'blocked_hosts', blocked);
      applied.push('local-llm:blocked');
    }
  }

  log.info('Applied base agent profile', {
    agentGroupId,
    applied: applied.length > 0 ? applied : 'nothing (keys absent or already set)',
  });
}
