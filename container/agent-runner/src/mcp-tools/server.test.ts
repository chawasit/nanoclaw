/**
 * Tests for the MCP server's tool-dispatch guard. A tool handler that throws
 * must not propagate raw to the SDK — the dispatcher (callTool) converts it
 * into an actionable isError text result the agent can read and react to.
 */
import { describe, it, expect } from 'bun:test';

import { registerTools, callTool } from './server.js';
import type { McpToolDefinition } from './types.js';

const throwingTool: McpToolDefinition = {
  tool: { name: '_test_throwing_tool', description: 't', inputSchema: { type: 'object' as const, properties: {} } },
  async handler() {
    throw new Error('boom');
  },
};

const okTool: McpToolDefinition = {
  tool: { name: '_test_ok_tool', description: 't', inputSchema: { type: 'object' as const, properties: {} } },
  async handler() {
    return { content: [{ type: 'text' as const, text: 'fine' }] };
  },
};

registerTools([throwingTool, okTool]);

describe('callTool — handler error guard', () => {
  it('turns a thrown handler error into an actionable isError result', async () => {
    const res = await callTool('_test_throwing_tool', {});
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('_test_throwing_tool'); // names the failing tool
    expect(text).toContain('boom'); // surfaces the underlying message
  });

  it('passes a normal handler result through unchanged', async () => {
    const res = await callTool('_test_ok_tool', {});
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toBe('fine');
  });
});
