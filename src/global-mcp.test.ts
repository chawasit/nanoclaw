import { describe, it, expect } from 'vitest';
import { applyGlobalRemoteMcps, MCP_REMOTE_PKG, type GlobalRemoteMcpUrls } from './global-mcp.js';
import type { McpServerConfig } from './container-config.js';

const PLOY_URL = 'https://ploy.trirat.co/mcp?secret=abc';
const CREW_URL = 'http://192.168.1.36:3000/mcp';

describe('applyGlobalRemoteMcps', () => {
  it('adds both entries + appends both hostnames to NO_PROXY, preserving existing entries', () => {
    const urls: GlobalRemoteMcpUrls = { ploy: PLOY_URL, crewBeverage: CREW_URL };
    const { mcpServers, env } = applyGlobalRemoteMcps(undefined, { NO_PROXY: '192.168.1.31', no_proxy: '192.168.1.31' }, urls);

    expect(mcpServers?.ploy).toEqual({
      command: 'npx',
      args: ['-y', MCP_REMOTE_PKG, PLOY_URL, '--transport', 'http-first'],
      instructions: expect.stringContaining('Horizon Harvest'),
    });
    expect(mcpServers?.['crew-beverage']).toEqual({
      command: 'npx',
      args: ['-y', MCP_REMOTE_PKG, CREW_URL, '--transport', 'http-first'],
      instructions: expect.stringContaining('Crew Beverage Tracker'),
    });

    const noProxyHosts = env?.NO_PROXY?.split(',') ?? [];
    expect(noProxyHosts).toContain('192.168.1.31');
    expect(noProxyHosts).toContain('ploy.trirat.co');
    expect(noProxyHosts).toContain('192.168.1.36');
    expect(env?.no_proxy).toBe(env?.NO_PROXY);
  });

  it('only adds crew-beverage when only its URL is set, and only appends its hostname', () => {
    const urls: GlobalRemoteMcpUrls = { crewBeverage: CREW_URL };
    const { mcpServers, env } = applyGlobalRemoteMcps(undefined, { NO_PROXY: '192.168.1.31' }, urls);

    expect(mcpServers?.ploy).toBeUndefined();
    expect(mcpServers?.['crew-beverage']).toBeDefined();
    const noProxyHosts = env?.NO_PROXY?.split(',') ?? [];
    expect(noProxyHosts).toEqual(['192.168.1.31', '192.168.1.36']);
  });

  it('returns the SAME references when neither URL is set (immutable no-op)', () => {
    const mcpServers: Record<string, McpServerConfig> = { exa: { command: 'npx', args: ['-y', 'exa-mcp-server@3.2.1'] } };
    const env = { NO_PROXY: '192.168.1.31' };
    const result = applyGlobalRemoteMcps(mcpServers, env, {});

    expect(result.mcpServers).toBe(mcpServers);
    expect(result.env).toBe(env);
  });

  it('returns the SAME references when both URLs already exist as entries (idempotent no-op)', () => {
    const mcpServers: Record<string, McpServerConfig> = {
      ploy: { command: 'npx', args: ['-y', MCP_REMOTE_PKG, PLOY_URL, '--transport', 'http-first'] },
      'crew-beverage': { command: 'npx', args: ['-y', MCP_REMOTE_PKG, CREW_URL, '--transport', 'http-first'] },
    };
    const env = { NO_PROXY: '192.168.1.31,ploy.trirat.co,192.168.1.36' };
    const result = applyGlobalRemoteMcps(mcpServers, env, { ploy: PLOY_URL, crewBeverage: CREW_URL });

    expect(result.mcpServers).toBe(mcpServers);
    expect(result.env).toBe(env);
  });

  it('running twice does not duplicate NO_PROXY entries or overwrite the entries', () => {
    const urls: GlobalRemoteMcpUrls = { ploy: PLOY_URL, crewBeverage: CREW_URL };
    const first = applyGlobalRemoteMcps(undefined, undefined, urls);
    const second = applyGlobalRemoteMcps(first.mcpServers, first.env, urls);

    expect(second.mcpServers).toBe(first.mcpServers);
    expect(second.env).toBe(first.env);
    expect(second.env?.NO_PROXY?.split(',').filter((h) => h === 'ploy.trirat.co')).toHaveLength(1);
    expect(second.env?.NO_PROXY?.split(',').filter((h) => h === '192.168.1.36')).toHaveLength(1);
  });

  it('preserves a pre-existing mcpServers.exa entry untouched', () => {
    const mcpServers: Record<string, McpServerConfig> = { exa: { command: 'npx', args: ['-y', 'exa-mcp-server@3.2.1'] } };
    const { mcpServers: next } = applyGlobalRemoteMcps(mcpServers, undefined, { ploy: PLOY_URL });

    expect(next?.exa).toEqual(mcpServers.exa);
    expect(next?.ploy).toBeDefined();
  });

  it('never overwrites an operator-provided existing entry of the same name', () => {
    const customPloy: McpServerConfig = { command: 'echo', args: ['custom'] };
    const mcpServers: Record<string, McpServerConfig> = { ploy: customPloy };
    const { mcpServers: next } = applyGlobalRemoteMcps(mcpServers, undefined, { ploy: PLOY_URL });

    expect(next?.ploy).toBe(customPloy);
  });

  it('NO_PROXY absent becomes just the new host(s)', () => {
    const { env } = applyGlobalRemoteMcps(undefined, undefined, { crewBeverage: CREW_URL });
    expect(env?.NO_PROXY).toBe('192.168.1.36');
    expect(env?.no_proxy).toBe('192.168.1.36');
  });

  it('parses hostname correctly from URLs with ports and query strings', () => {
    const r1 = applyGlobalRemoteMcps(undefined, undefined, { crewBeverage: 'http://192.168.1.36:3000/mcp' });
    expect(r1.env?.NO_PROXY).toBe('192.168.1.36');

    const r2 = applyGlobalRemoteMcps(undefined, undefined, { ploy: 'https://ploy.trirat.co/x?secret=y' });
    expect(r2.env?.NO_PROXY).toBe('ploy.trirat.co');
  });
});
