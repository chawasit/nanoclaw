/**
 * Pure scoring math for `memory_search` (M-mem2/3). No filesystem access here —
 * `memory-search.ts` does the I/O (reading files, stat'ing mtimes) and passes
 * plain values in, so this module is trivially unit-testable.
 */

// --- Relevance -------------------------------------------------------------

/** Frontmatter is optional; a memory file with none (or a partial one) falls
 *  back to these. Confidence slightly below 1 because an untagged fact hasn't
 *  been explicitly vetted; importance mid-scale because most durable memories
 *  are "worth keeping" without being flagged critical. */
export const DEFAULT_CONFIDENCE = 0.7;
export const DEFAULT_IMPORTANCE = 0.5;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'with', 'that', 'this', 'it', 'as', 'be', 'by', 'at',
]);
const MIN_TOKEN_LENGTH = 3; // drop tokens of length <= 2 alongside stopwords
const TF_CAP = 3; // a term repeated beyond this contributes no further score

/** Coverage (how many distinct query terms matched) is weighted above raw
 *  term-frequency, so a fact that mentions every query word once beats one
 *  that repeats a single word many times. */
const RELEVANCE_COVERAGE_WEIGHT = 0.7;
const RELEVANCE_TF_WEIGHT = 0.3;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > MIN_TOKEN_LENGTH - 1 && !STOPWORDS.has(t));
}

// SEAM: swap for bge-m3 embeddings later — same signature (query, text) => [0,1].
/**
 * Lexical relevance in [0,1]: a coverage+TF blend. `coverage` = fraction of
 * distinct query terms found anywhere in `text`; `tf` = mean of each matched
 * term's frequency capped at TF_CAP, normalized to [0,1]. Deterministic, no
 * external calls.
 */
export function relevance(query: string, text: string): number {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return 0;

  const textTokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of textTokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  let matched = 0;
  let tfSum = 0;
  for (const term of queryTerms) {
    const count = freq.get(term) ?? 0;
    if (count > 0) matched += 1;
    tfSum += Math.min(count, TF_CAP) / TF_CAP;
  }

  const coverage = matched / queryTerms.length;
  const tf = tfSum / queryTerms.length;
  return coverage * RELEVANCE_COVERAGE_WEIGHT + tf * RELEVANCE_TF_WEIGHT;
}

// --- Frontmatter -------------------------------------------------------------

export interface MemoryMetadata {
  confidence: number;
  importance: number;
}

/**
 * Minimal hand-rolled parser for the tiny frontmatter subset we need:
 * a `---`-delimited block at the very top of the file containing `confidence:`
 * and/or `importance:` (flat or nested one level under `metadata:` — both
 * shapes are matched the same way since indentation doesn't change the
 * result). Absent, partial, or malformed frontmatter (no closing `---`) all
 * fall back to the documented defaults without throwing — the whole file is
 * then treated as the body.
 */
export function parseFrontmatter(raw: string): { metadata: MemoryMetadata; body: string } {
  const defaults: MemoryMetadata = { confidence: DEFAULT_CONFIDENCE, importance: DEFAULT_IMPORTANCE };
  if (!raw.startsWith('---')) return { metadata: defaults, body: raw };

  const closing = raw.indexOf('\n---', 3);
  if (closing === -1) return { metadata: defaults, body: raw }; // malformed — no closing delimiter

  const block = raw.slice(0, closing);
  const body = raw.slice(closing + 4).replace(/^\r?\n/, '');

  const confidenceMatch = block.match(/confidence:\s*([\d.]+)/);
  const importanceMatch = block.match(/importance:\s*([\d.]+)/);
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) : DEFAULT_CONFIDENCE;
  const importance = importanceMatch ? Number(importanceMatch[1]) : DEFAULT_IMPORTANCE;

  return {
    metadata: {
      confidence: Number.isFinite(confidence) ? confidence : DEFAULT_CONFIDENCE,
      importance: Number.isFinite(importance) ? importance : DEFAULT_IMPORTANCE,
    },
    body,
  };
}

// --- Final score -------------------------------------------------------------

/** A fact's relevance halves roughly every 90 days of age, but never decays
 *  past RECENCY_FLOOR — an old-but-relevant fact must still be findable. */
export const HALF_LIFE_DAYS = 90;
export const RECENCY_FLOOR = 0.15;

/** Relevance dominates the blend (0.7) over confidence/importance (0.15 each)
 *  — tuned so a clearly-more-relevant fact outranks a stale, low-relevance one
 *  even when that one carries perfect confidence/importance/recency. At 0.6/
 *  0.2/0.2 the multiplicative recency term could still let a merely-older,
 *  higher-relevance fact lose to a very fresh, low-relevance one. */
const W_REL = 0.7;
const W_CONF = 0.15;
const W_IMP = 0.15;

export interface ScoreInput {
  relevance: number;
  confidence: number;
  importance: number;
  /** Days since the fact's frontmatter `updated`/`created` date, or file mtime. */
  ageDays: number;
}

export interface ScoreBreakdown {
  relevance: number;
  confidence: number;
  importance: number;
  recencyFactor: number;
}

export function scoreMemory(input: ScoreInput): { score: number; breakdown: ScoreBreakdown } {
  const recencyFactor = Math.max(RECENCY_FLOOR, Math.exp(-input.ageDays / HALF_LIFE_DAYS));
  const blend = W_REL * input.relevance + W_CONF * input.confidence + W_IMP * input.importance;
  return {
    score: blend * recencyFactor,
    breakdown: {
      relevance: input.relevance,
      confidence: input.confidence,
      importance: input.importance,
      recencyFactor,
    },
  };
}
