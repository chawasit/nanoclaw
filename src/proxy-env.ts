/**
 * Auto-inject the LiteLLM-proxy env for proxy-routed models, recomputed each spawn.
 *
 * Background: the CoS keeps creating agents on a LiteLLM-proxy model (glm-* / minimax-*
 * / gemini-* / gpt-*) but with an EMPTY container env, so the agent points at the
 * default Anthropic endpoint with no working key and is dead-on-arrival (broke
 * research-lead / research-gemini / research-gpt). This module closes that gap: at
 * spawn time, if the model is a proxy-routed family AND the spine knows the proxy host
 * (NANOCLAW_PROXY_BASE_URL + NANOCLAW_PROXY_API_KEY, read by the CALLER and passed in),
 * inject ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / NO_PROXY / no_proxy so the agent can
 * actually reach the proxy — and mark api.anthropic.com blocked so it can't spend on
 * the vault key by accident.
 *
 * Scope: ONLY the four LiteLLM-route families. Local gemma (`gemma`, `unsloth/...`)
 * uses the ampere base URL (a DIFFERENT env, set elsewhere) and Claude (`claude-*`)
 * uses the vault key — neither is matched here. Explicit ALWAYS wins: if the agent
 * already has an explicit ANTHROPIC_BASE_URL (e.g. a gemma agent pointed at ampere, or
 * a hand-tuned route), nothing is touched. Pure + table-driven tested; the caller
 * (materializeContainerJson) reads process.env and wires it next to the auto-compact
 * window overlay. Env-gated: no host config -> no-op. dev-log/0068.
 */

/** Model-id prefixes that route through the LiteLLM proxy (after vendor/ strip + lowercase). */
export const PROXY_MODEL_PREFIXES: readonly string[] = ['glm', 'minimax', 'gemini', 'gpt'];

/** The host the spine should point proxy agents at (read by the caller from its own env). */
export interface ProxyHost {
  baseUrl?: string;
  apiKey?: string;
}

/** The env overlay injected for a proxy model. */
export interface ProxyEnvOverlay {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  NO_PROXY: string;
  no_proxy: string;
}

/** True if the model id (after stripping a leading `vendor/` and lowercasing) is a proxy family. */
export function isProxyModel(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return PROXY_MODEL_PREFIXES.some((p) => bare.startsWith(p));
}

/**
 * Env overlay for a proxy model IFF the model is a proxy family AND the host config
 * (baseUrl + apiKey) is present; else null. Pure — no process.env access.
 */
export function proxyEnvForModel(model: string | undefined, host: ProxyHost | undefined): ProxyEnvOverlay | null {
  if (!isProxyModel(model)) return null;
  const baseUrl = host?.baseUrl;
  const apiKey = host?.apiKey;
  if (!baseUrl || !apiKey) return null; // env-gated: spine doesn't know the proxy -> no-op
  const proxyHost = new URL(baseUrl).hostname; // hostname only, no port (mirrors local-llm overlay)
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
    NO_PROXY: proxyHost,
    no_proxy: proxyHost,
  };
}

/**
 * Merge the proxy env overlay into `env` for a proxy model — UNLESS the agent already
 * has an explicit ANTHROPIC_BASE_URL (explicit always wins; never clobber a hand-set
 * base/key, e.g. a gemma agent on ampere). Immutable: returns a new object only when
 * it changes, else the original reference.
 */
export function applyProxyEnv(
  env: Record<string, string> | undefined,
  model: string | undefined,
  host: ProxyHost | undefined,
): Record<string, string> | undefined {
  if (env?.ANTHROPIC_BASE_URL) return env; // explicit wins -> untouched
  const overlay = proxyEnvForModel(model, host);
  if (!overlay) return env; // not a proxy model, or no host config -> untouched
  return { ...(env ?? {}), ...overlay };
}

/**
 * Whether `api.anthropic.com` should be added to blocked_hosts for this agent: only
 * when applyProxyEnv would actually inject the overlay (proxy model + host config +
 * no explicit base URL). Fires together with the env injection or not at all, so an
 * operator's hand-set env/blocked_hosts is never partially overwritten.
 */
export function shouldBlockAnthropicForProxy(
  env: Record<string, string> | undefined,
  model: string | undefined,
  host: ProxyHost | undefined,
): boolean {
  if (env?.ANTHROPIC_BASE_URL) return false; // explicit wins
  return proxyEnvForModel(model, host) !== null;
}
