import { describe, expect, test } from 'bun:test';

import { formatMcpServerStatus } from './mcp-status.js';

describe('formatMcpServerStatus', () => {
  test('returns null when there is no init message or no servers', () => {
    expect(formatMcpServerStatus(undefined)).toBeNull();
    expect(formatMcpServerStatus(null)).toBeNull();
    expect(formatMcpServerStatus({})).toBeNull();
    expect(formatMcpServerStatus({ mcp_servers: [] })).toBeNull();
  });

  test('formats a healthy server list with no unhealthy entries', () => {
    const r = formatMcpServerStatus({
      mcp_servers: [
        { name: 'exa', status: 'connected' },
        { name: 'firecrawl', status: 'connected' },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.line).toBe('MCP servers: exa=connected firecrawl=connected');
    expect(r!.unhealthy).toEqual([]);
  });

  test('flags non-connected servers as unhealthy (the case worth catching)', () => {
    const r = formatMcpServerStatus({
      mcp_servers: [
        { name: 'exa', status: 'connected' },
        { name: 'firecrawl', status: 'failed' },
      ],
    });
    expect(r!.unhealthy).toEqual(['firecrawl']);
    expect(r!.line).toContain('firecrawl=failed');
  });

  test('is defensive against malformed shapes and never throws', () => {
    expect(formatMcpServerStatus({ mcp_servers: 'nope' })).toBeNull();
    const r = formatMcpServerStatus({ mcp_servers: [{}, { name: 'x' }, { status: 'failed' }] });
    expect(r).not.toBeNull();
    expect(r!.unhealthy.length).toBeGreaterThanOrEqual(1);
  });
});
