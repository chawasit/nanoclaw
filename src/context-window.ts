/**
 * Per-model auto-compact window (tokens), recomputed each spawn from the live model.
 *
 * The agent-runner hard-defaults the Claude-agent-SDK compaction window to 165K
 * (providers/claude.ts) — right for the old 200K tier, but it throws away context
 * that 1M-context cloud models can hold. This makes the window AUTO-FOLLOW the model
 * tier: promote a worker onto a cloud model and it gets the bigger window on its next
 * spawn; demote it back to local gemma and it returns to 165K (which gemma NEEDS —
 * it re-prefills the whole context every turn with no KV-cache reuse, so a big window
 * thrashes it). An explicit env value always wins (operator escape hatch).
 *
 * Values verified 2026-06-23 through the LiteLLM proxy: glm-5.2 (DeepInfra) = 1M
 * context, prompt caching works through the proxy (cache_read confirmed), no pricing
 * cliff -> 700K. minimax-m3 (MiniMax /v1) = 1M but a hard 512K input pricing cliff +
 * caching unconfirmed through the proxy -> conservative 300K. Anything else (local
 * gemma, Claude vault, unknown) -> undefined = leave the 165K agent-runner default.
 * dev-log/0061.
 */

export const AUTO_COMPACT_WINDOW: Readonly<Record<string, string>> = {
  glm: '700000',
  minimax: '300000',
};

/** Window (tokens) for a model id, or undefined to keep the 165K agent-runner default. */
export function autoCompactWindowForModel(model: string | undefined, explicit?: string): string | undefined {
  if (explicit) return explicit; // operator override always wins
  const m = (model ?? '').toLowerCase();
  if (m.includes('glm')) return AUTO_COMPACT_WINDOW.glm;
  if (m.includes('minimax')) return AUTO_COMPACT_WINDOW.minimax;
  return undefined; // gemma / local / claude / unknown -> 165K default downstream
}

/**
 * Return env with CLAUDE_CODE_AUTO_COMPACT_WINDOW set per the model tier. Immutable
 * (returns a new object only when it changes). An explicit existing value is kept.
 */
export function applyAutoCompactWindow(
  env: Record<string, string> | undefined,
  model: string | undefined,
): Record<string, string> | undefined {
  const explicit = env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const win = autoCompactWindowForModel(model, explicit);
  if (!win) return env; // no elevation -> leave env untouched (165K default applies)
  if (env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW === win) return env; // already set
  return { ...(env ?? {}), CLAUDE_CODE_AUTO_COMPACT_WINDOW: win };
}
