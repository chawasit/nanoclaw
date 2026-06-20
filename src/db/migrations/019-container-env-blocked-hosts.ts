import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-agent-group container env overrides + blocked hosts.
 * Mirrors the additional_mounts JSON-column pattern. Enables routing a group
 * to a local Ollama LLM (env: ANTHROPIC_BASE_URL/NO_PROXY) and pinning hosts
 * to 0.0.0.0 (blocked_hosts: e.g. api.anthropic.com to prevent API spend).
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-env-blocked-hosts',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'").run();
    db.prepare("ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT NOT NULL DEFAULT '[]'").run();
  },
};
