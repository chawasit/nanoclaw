/**
 * Surface MCP-server connection status from the SDK's `init` system message.
 *
 * The claude-agent-sdk attempts each configured MCP server connection at session
 * init and reports the outcome on the init message as
 * `mcp_servers: { name, status }[]` (status: "connected" | "failed" | "pending").
 * We log it in the runner so a configured-but-dead server (bad command,
 * version-not-found, launch crash) is visible post-spawn — the faithful #3
 * health-check (real container env + proxy path). Bad API keys are NOT caught
 * here (a local init never calls the API).
 *
 * Pure + defensive: any unexpected shape yields null (inert — never throws inside
 * the SDK message loop).
 */
export interface McpServerStatusReport {
  line: string;
  unhealthy: string[];
}

export function formatMcpServerStatus(initMessage: unknown): McpServerStatusReport | null {
  const servers = (initMessage as { mcp_servers?: unknown } | null | undefined)?.mcp_servers;
  if (!Array.isArray(servers) || servers.length === 0) return null;

  const entries: string[] = [];
  const unhealthy: string[] = [];
  for (const s of servers) {
    const rawName = (s as { name?: unknown })?.name;
    const rawStatus = (s as { status?: unknown })?.status;
    const name = typeof rawName === 'string' ? rawName : '?';
    const status = typeof rawStatus === 'string' ? rawStatus : 'unknown';
    entries.push(`${name}=${status}`);
    if (status !== 'connected') unhealthy.push(name);
  }
  return { line: `MCP servers: ${entries.join(' ')}`, unhealthy };
}
