/**
 * Workspace overlay — applied at SPAWN time (dev-log/0067 workspace-model redesign;
 * supersedes the per-agent NAS work + team/<report> mounts of dev-log/0048).
 *
 * The flat-NAS static mounts (base-profile.ts) give every agent vault-RO + shared.
 * This spawn-time overlay does the two things that depend on the LIVE org graph or
 * must be recomputed every spawn (so they can't be persisted at create time):
 *
 *   - **vault RW promotion (upgrade-only):** a *leader* gets the vault read-write.
 *     `readonly = staticReadonly && !isLeader` — so a manually-granted static RW
 *     (e.g. the MD) is NEVER downgraded, a worker that gains reports is promoted,
 *     and an agent that was *dynamically* promoted reverts to RO when it loses them.
 *   - **strip the legacy per-agent `work` mount:** the old model mounted the agent's
 *     own NAS `work/<id>` dir at /workspace/extra/work. That mount is RETIRED — an
 *     agent's private/working files now live in its durable group folder at
 *     /workspace/agent. Existing agents still carry `work` in their persisted
 *     `additional_mounts` (base-profile wrote it before this change), so the overlay
 *     actively filters it out every spawn; leader oversight moved to the visualizer
 *     (re-mounting group folders was rejected — they hold container.json with secrets).
 *
 * Pure + injectable (no DB/fs import) so it unit-tests without a database; the caller
 * (materializeContainerJson) gathers the live org facts and passes them in.
 * Graceful: a no-op when COMPANY_NAS_PATH is unset (prod-without-NAS, test instance).
 */
import type { AdditionalMountConfig } from './container-config.js';

export interface LeaderMountInput {
  nasPath: string | undefined;
  isLeader: boolean;
}

export function applyLeaderWorkspaceMounts(
  mounts: AdditionalMountConfig[],
  input: LeaderMountInput,
): AdditionalMountConfig[] {
  const { nasPath, isLeader } = input;
  if (!nasPath) return mounts;

  return mounts
    // Drop the retired per-agent NAS work mount (existing agents still persist it).
    .filter((m) => m.containerPath !== 'work')
    // vault: upgrade-only RW for leaders (immutably; never downgrade a static RW).
    .map((m) => (m.containerPath === 'vault' ? { ...m, readonly: m.readonly && !isLeader } : m));
}
