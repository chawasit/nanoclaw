/**
 * Global remote MCP servers — injected for EVERY agent, at EVERY spawn (unlike
 * base-profile.ts's exa/firecrawl, which are create-only). Covers `ploy` (Horizon
 * Harvest coffee roast-shop management) and `crew-beverage` (worker beverage
 * tracker), each key-gated on its own URL env var so this is fully inert until an
 * operator sets it.
 *
 * Nanoclaw's McpServerConfig is stdio-only ({command, args?, env?, instructions?}).
 * These two are remote HTTP MCP servers, so they run through the `mcp-remote`
 * stdio<->HTTP bridge: `npx -y mcp-remote@<ver> <url> --transport http-first`.
 *
 * The onecli egress proxy blocks arbitrary outbound hosts, so each configured
 * remote's hostname is appended to the container's NO_PROXY/no_proxy (mirrors the
 * dedup-preserving pattern in base-profile.ts's local-LLM overlay) so its traffic
 * bypasses the proxy instead of being blocked.
 *
 * Idempotent + immutable: never overwrites an existing mcpServers[name] entry
 * (operator customization always wins), and returns the SAME mcpServers/env
 * references when nothing needs to change.
 */
import type { McpServerConfig } from './container-config.js';

/** Pinned version — MUST match the bake in container/Dockerfile. */
export const MCP_REMOTE_PKG = 'mcp-remote@0.1.38';

/** The URL for each global remote MCP, resolved by the caller (usually process.env). */
export interface GlobalRemoteMcpUrls {
  ploy?: string;
  crewBeverage?: string;
}

interface GlobalRemoteMcp {
  readonly name: string;
  readonly urlKey: keyof GlobalRemoteMcpUrls;
  readonly instructions: string;
}

const GLOBAL_REMOTE_MCPS: readonly GlobalRemoteMcp[] = [
  {
    name: 'ploy',
    urlKey: 'ploy',
    instructions:
      'Ploy MCP — Horizon Harvest coffee roast-shop management (green bean, roasting, packaging, product, quality, stock, customer). WRITE-enabled on PRODUCTION data — confirm intent before any mutating call.',
  },
  {
    name: 'crew-beverage',
    urlKey: 'crewBeverage',
    instructions:
      'Crew Beverage Tracker MCP — records drinks/beverages issued to workers on duty (stock balance, current prices, requisition in/out log, spend-by-range).',
  },
];

/** Add `host` to a comma-joined NO_PROXY list, deduped, preserving existing entries + order. */
function appendNoProxyHost(current: string | undefined, host: string): string {
  const hosts = new Set(
    (current ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  );
  hosts.add(host);
  return [...hosts].join(',');
}

/**
 * Overlay the two global remote MCPs onto `mcpServers` for every URL that is
 * configured (non-empty string) and not already present under that name, and
 * append each newly-added remote's hostname to `env.NO_PROXY`/`env.no_proxy`.
 * Pure and immutable: returns the SAME `mcpServers`/`env` references when there
 * is nothing to add (neither URL set, or both already present).
 */
export function applyGlobalRemoteMcps(
  mcpServers: Record<string, McpServerConfig> | undefined,
  env: Record<string, string> | undefined,
  urls: GlobalRemoteMcpUrls,
): { mcpServers: Record<string, McpServerConfig> | undefined; env: Record<string, string> | undefined } {
  const toAdd = GLOBAL_REMOTE_MCPS.filter((m) => {
    const url = urls[m.urlKey];
    return typeof url === 'string' && url.length > 0 && !mcpServers?.[m.name];
  });
  if (toAdd.length === 0) return { mcpServers, env };

  const nextMcpServers = { ...(mcpServers ?? {}) };
  let noProxy = env?.NO_PROXY;

  for (const m of toAdd) {
    const url = urls[m.urlKey] as string;
    nextMcpServers[m.name] = {
      command: 'npx',
      args: ['-y', MCP_REMOTE_PKG, url, '--transport', 'http-first'],
      instructions: m.instructions,
    };
    noProxy = appendNoProxyHost(noProxy, new URL(url).hostname);
  }

  const nextEnv = { ...(env ?? {}), NO_PROXY: noProxy as string, no_proxy: noProxy as string };
  return { mcpServers: nextMcpServers, env: nextEnv };
}
