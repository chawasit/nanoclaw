import { describe, expect, it } from 'vitest';

import { buildHandshakeFrames, classify, parseRpcLines, serversFromContainerJson } from './mcp-smoke.js';

describe('buildHandshakeFrames', () => {
  it('produces valid single-line JSON-RPC frames with the right methods/ids', () => {
    const f = buildHandshakeFrames();
    const init = JSON.parse(f.initialize);
    expect(init.method).toBe('initialize');
    expect(init.id).toBe(1);
    expect(JSON.parse(f.initialized).method).toBe('notifications/initialized');
    const tl = JSON.parse(f.toolsList);
    expect(tl.method).toBe('tools/list');
    expect(tl.id).toBe(2);
    // newline-delimited transport: a frame must not contain embedded newlines
    expect(f.initialize.includes('\n')).toBe(false);
  });
});

describe('parseRpcLines', () => {
  it('extracts complete JSON messages and carries the partial remainder', () => {
    const a = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
    const b = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    const { messages, rest } = parseRpcLines(`${a}\n${b}\n{"id":3,"par`);
    expect(messages).toHaveLength(2);
    expect(messages[1].id).toBe(2);
    expect(rest).toBe('{"id":3,"par');
  });

  it('ignores non-JSON log noise the server may print to stdout', () => {
    const ok = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
    const { messages } = parseRpcLines(`starting server...\n${ok}\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(1);
  });
});

describe('classify', () => {
  it('OK when the server answered initialize (with tool count when known)', () => {
    expect(classify({ sawInit: true, toolCount: 5, exitCode: null, timedOut: false, stderr: '' })).toEqual({
      status: 'ok',
      detail: '5 tools',
    });
    expect(
      classify({ sawInit: true, toolCount: null, exitCode: null, timedOut: false, stderr: '' }).status,
    ).toBe('ok');
  });

  it('FAILED when the server never initialized and exited non-zero (the must-catch case)', () => {
    const r = classify({ sawInit: false, toolCount: null, exitCode: 1, timedOut: false, stderr: 'npm error 404 Not Found' });
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('404');
  });

  it('TIMEOUT when nothing came back before the deadline', () => {
    expect(
      classify({ sawInit: false, toolCount: null, exitCode: null, timedOut: true, stderr: '' }).status,
    ).toBe('timeout');
  });
});

describe('serversFromContainerJson', () => {
  it('reads either mcpServers or mcp_servers, defaulting to empty', () => {
    expect(serversFromContainerJson({ mcpServers: { exa: { command: 'npx' } } })).toHaveProperty('exa');
    expect(serversFromContainerJson({ mcp_servers: { f: { command: 'npx' } } })).toHaveProperty('f');
    expect(serversFromContainerJson({})).toEqual({});
    expect(serversFromContainerJson(null)).toEqual({});
  });
});
