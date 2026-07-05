/**
 * memory_search MCP tool (M-mem2/3): read-only lexical search over the
 * agent's OWN durable memory facts under /workspace/agent/memory/, ranked by
 * relevance + recency + importance + confidence (see scoreMemory.ts for the
 * math). $0-local, no embeddings, no network — a documented seam
 * (`relevance()` in scoreMemory.ts) is left for swapping in bge-m3 later.
 *
 * Never leader-gated: every agent may call this — it only ever reads the
 * CALLER's own memory dir, resolved the same way `loadConfig()` resolves the
 * rest of the container config (container.json lives at the fixed container
 * path `/workspace/agent/container.json`, see config.ts — there is no
 * separate "home dir" helper to reuse, so `/workspace/agent/memory/` is the
 * literal default per src/agent-home.ts).
 *
 * Ranking invariant: a fact with zero query relevance never outranks one with
 * any nonzero relevance, even if its combined confidence/importance/recency
 * score is higher. Implemented as an explicit two-tier sort below (not baked
 * into the scoring formula) — zero-relevance facts only ever appear as filler
 * when there aren't `limit` real matches.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import { relevance, parseFrontmatter, scoreMemory } from './scoreMemory.js';
import type { McpToolDefinition } from './types.js';

const MEMORY_DIR = '/workspace/agent/memory';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SNIPPET_LENGTH = 150;

let memoryDirOverride: string | null = null;
/** Test-only seam — never called from production code. */
export function __setMemoryDirForTest(dir: string | null): void {
  memoryDirOverride = dir;
}
function getMemoryDir(): string {
  return memoryDirOverride ?? MEMORY_DIR;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Pulls an `updated:`/`created:` date out of the frontmatter block, if
 *  present and parseable. Returns null on anything else (absent, malformed,
 *  unparseable) — the caller falls back to file mtime. */
function frontmatterDate(raw: string): Date | null {
  if (!raw.startsWith('---')) return null;
  const closing = raw.indexOf('\n---', 3);
  const block = closing === -1 ? raw : raw.slice(0, closing);
  const match = block.match(/(?:updated|created):\s*(\S+)/);
  if (!match) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function snippetOf(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  return trimmed.length > SNIPPET_LENGTH ? `${trimmed.slice(0, SNIPPET_LENGTH)}…` : trimmed;
}

interface RankedFact {
  file: string;
  score: number;
  snippet: string;
  why: string;
}

export const memorySearch: McpToolDefinition = {
  tool: {
    name: 'memory_search',
    description:
      "Search your OWN durable memory (/workspace/agent/memory/*.md) by topic instead of reading every file. Returns the most relevant facts ranked by relevance + recency + importance + confidence. Read-only — never writes, edits, or deletes memory.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for, e.g. "deploy runbook" or "owner preferences"' },
        limit: { type: 'number', description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = (args.query as string) || '';
    const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit) || DEFAULT_LIMIT));

    const dir = getMemoryDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return ok(`No memory directory found yet at ${dir} — nothing to search.`);
    }

    const files = entries.filter((f) => f.endsWith('.md'));
    if (files.length === 0) {
      return ok(`No memory files found under ${dir} yet.`);
    }

    const facts: RankedFact[] = [];
    const relevances: number[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      let raw: string;
      let mtimeMs: number;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue; // skip a file that vanished/errored mid-scan rather than failing the whole search
      }

      const { metadata, body } = parseFrontmatter(raw);
      const date = frontmatterDate(raw);
      const ageDays = Math.max(0, (Date.now() - (date ? date.getTime() : mtimeMs)) / 86_400_000);

      const rel = relevance(query, `${file}\n${body}`);
      const { score, breakdown } = scoreMemory({ relevance: rel, confidence: metadata.confidence, importance: metadata.importance, ageDays });

      relevances.push(rel);
      facts.push({
        file,
        score,
        snippet: snippetOf(body),
        why: `rel=${breakdown.relevance.toFixed(2)} conf=${breakdown.confidence.toFixed(2)} imp=${breakdown.importance.toFixed(2)} recency=${breakdown.recencyFactor.toFixed(2)}`,
      });
    }

    // Two-tier sort: any real match outranks every zero-relevance fallback,
    // regardless of score. See module header for why this isn't in the formula.
    const relevant = facts.filter((_, i) => relevances[i] > 0).sort((a, b) => b.score - a.score);
    const fallback = facts.filter((_, i) => relevances[i] === 0).sort((a, b) => b.score - a.score);
    const results = [...relevant, ...fallback].slice(0, limit);

    if (results.length === 0) {
      return ok(`No memory files matched "${query}" under ${dir}.`);
    }

    const lines = results.map((r) => `- ${r.file} (${r.why})\n  ${r.snippet}`);
    return ok(lines.join('\n'));
  },
};

registerTools([memorySearch]);
