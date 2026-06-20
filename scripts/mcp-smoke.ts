/**
 * MCP launch smoke test (host-side, out-of-band). qa-report/0002 #3.
 *
 * Spawn each MCP server `command`+`args` the way the agent-runner would and run a
 * minimal MCP stdio handshake (initialize -> tools/list). Catches the *launch*
 * failure class — bad command, version-not-found (npx can't resolve pkg@ver),
 * import/launch crash — and reports the tool count on success.
 *
 * SCOPE (honest): runs in the HOST environment, NOT inside an agent container.
 *   - Does NOT verify API keys (a local handshake never calls the upstream API).
 *   - Can give a FALSE OK on container-only failures: the host fetches npm directly
 *     while a container fetches via the OneCLI proxy, so a broken container proxy
 *     path is invisible here. Treat this as a pre-wiring / config sanity check, not
 *     a guarantee the agent's servers are live (see dev-log/0026 for why the faithful
 *     in-container signal — the SDK init status — is a premature snapshot).
 *
 * Usage:
 *   pnpm exec tsx scripts/mcp-smoke.ts --npx exa-mcp-server@3.2.1
 *   pnpm exec tsx scripts/mcp-smoke.ts --group _ping-test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProbeOutcome {
  status: 'ok' | 'failed' | 'timeout';
  detail: string;
}

export interface ProbeResult extends ProbeOutcome {
  name: string;
}

const INIT_ID = 1;
const TOOLS_ID = 2;
const DEFAULT_TIMEOUT_MS = 45000;

/** The three MCP stdio frames, newline-delimited JSON-RPC. */
export function buildHandshakeFrames(): { initialize: string; initialized: string; toolsList: string } {
  return {
    initialize: JSON.stringify({
      jsonrpc: '2.0',
      id: INIT_ID,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
      },
    }),
    initialized: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    toolsList: JSON.stringify({ jsonrpc: '2.0', id: TOOLS_ID, method: 'tools/list', params: {} }),
  };
}

/** Split a stdout buffer into complete JSON-RPC messages + the unparsed remainder. */
export function parseRpcLines(buffer: string): { messages: Array<Record<string, unknown>>; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const messages: Array<Record<string, unknown>> = [];
  for (const line of parts) {
    const t = line.trim();
    if (!t) continue;
    try {
      messages.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* non-JSON log line from the server — ignore */
    }
  }
  return { messages, rest };
}

/** Classify a finished probe. `sawInit` = server answered initialize (it launched + speaks MCP). */
export function classify(o: {
  sawInit: boolean;
  toolCount: number | null;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}): ProbeOutcome {
  if (o.sawInit) {
    return { status: 'ok', detail: o.toolCount != null ? `${o.toolCount} tools` : 'initialized (no tools/list)' };
  }
  if (o.timedOut) {
    return { status: 'timeout', detail: 'no MCP response before timeout (npx cold-start or hang)' };
  }
  const tail = o.stderr.trim().split('\n').slice(-2).join(' ').slice(-200);
  return { status: 'failed', detail: `exited ${o.exitCode}${tail ? `: ${tail}` : ''}` };
}

/** Load the mcp server map from a materialized container.json (pure given parsed json). */
export function serversFromContainerJson(json: unknown): Record<string, McpServerSpec> {
  const m = (json as { mcpServers?: unknown; mcp_servers?: unknown }) || {};
  const raw = (m.mcpServers ?? m.mcp_servers ?? {}) as Record<string, McpServerSpec>;
  return raw;
}

/** Spawn one server and run the handshake. Always kills the child on finish/timeout. */
export function probeServer(name: string, spec: McpServerSpec, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const frames = buildHandshakeFrames();
    const child = spawn(spec.command, spec.args ?? [], {
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let sawInit = false;
    let toolCount: number | null = null;
    let buf = '';
    let stderr = '';
    let done = false;

    const finish = (over: { timedOut?: boolean; exitCode?: number | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      const outcome = classify({
        sawInit,
        toolCount,
        exitCode: over.exitCode ?? null,
        timedOut: over.timedOut ?? false,
        stderr,
      });
      resolve({ name, ...outcome });
    };

    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

    child.on('error', (e) => {
      stderr += `spawn error: ${e.message}`;
      finish({ exitCode: null });
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const { messages, rest } = parseRpcLines(buf);
      buf = rest;
      for (const msg of messages) {
        if (msg.id === INIT_ID && 'result' in msg) {
          sawInit = true;
          try {
            child.stdin.write(frames.initialized + '\n');
            child.stdin.write(frames.toolsList + '\n');
          } catch {
            /* stdin closed */
          }
        } else if (msg.id === TOOLS_ID) {
          const result = msg.result as { tools?: unknown[] } | undefined;
          toolCount = Array.isArray(result?.tools) ? result!.tools.length : 0;
          finish({ exitCode: 0 });
        }
      }
    });
    child.on('close', (code) => finish({ exitCode: code }));

    try {
      child.stdin.write(frames.initialize + '\n');
    } catch {
      /* handled by error/close */
    }
  });
}

function loadServers(argv: string[]): Record<string, McpServerSpec> {
  const npxIdx = argv.indexOf('--npx');
  if (npxIdx >= 0 && argv[npxIdx + 1]) {
    const pkg = argv[npxIdx + 1];
    return { [pkg]: { command: 'npx', args: ['-y', pkg] } };
  }
  const groupIdx = argv.indexOf('--group');
  if (groupIdx >= 0 && argv[groupIdx + 1]) {
    const folder = argv[groupIdx + 1];
    const p = path.join('groups', folder, 'container.json');
    if (!fs.existsSync(p)) throw new Error(`container.json not found for group "${folder}" (${p})`);
    return serversFromContainerJson(JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  throw new Error('usage: mcp-smoke --npx <pkg@ver> | --group <folder>');
}

async function main(): Promise<void> {
  const servers = loadServers(process.argv.slice(2));
  const names = Object.keys(servers);
  if (names.length === 0) {
    console.log('No MCP servers to probe.');
    return;
  }
  console.log(`Probing ${names.length} MCP server(s)...`);
  const results = await Promise.all(names.map((n) => probeServer(n, servers[n])));
  let failures = 0;
  for (const r of results) {
    const mark = r.status === 'ok' ? 'OK ' : r.status === 'timeout' ? 'TIMEOUT' : 'FAIL';
    if (r.status !== 'ok') failures++;
    console.log(`  [${mark}] ${r.name} — ${r.detail}`);
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('mcp-smoke.ts')) {
  main().catch((e) => {
    console.error(`mcp-smoke error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
