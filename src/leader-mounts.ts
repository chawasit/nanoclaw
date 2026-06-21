/**
 * Leader workspace overlay — applied at SPAWN time (Phase 2, dev-log/0048).
 *
 * The flat-NAS static mounts (base-profile.ts) give every agent vault-RO + shared +
 * own work. This overlay adds the org-DEPENDENT pieces, which can't live at create
 * time (a new hire has no reports yet and create runs before the org edges exist):
 *
 *   - **vault RW promotion (upgrade-only):** a *leader* gets the vault read-write.
 *     `readonly = staticReadonly && !isLeader` — so a manually-granted static RW
 *     (e.g. the MD) is NEVER downgraded, a worker that gains reports is promoted,
 *     and an agent that was *dynamically* promoted reverts to RO when it loses them.
 *   - **team/<report> oversight:** each direct report's `work/<id>` mounted RO at
 *     `team/<label>` (need-to-know: peers don't see peers' work; a leader sees its
 *     reports'). NEVER persisted — recomputed from the live org graph every spawn,
 *     so a reorg (hire/fire/reassign) just changes what's mounted next spawn.
 *
 * Pure + injectable (no DB import) so it unit-tests without a database; the caller
 * (materializeContainerJson) gathers the live org facts and passes them in.
 * Graceful: a no-op when COMPANY_NAS_PATH is unset (prod-without-NAS, test instance).
 */
import fs from 'fs';
import path from 'path';

import type { AdditionalMountConfig } from './container-config.js';

export interface LeaderReport {
  id: string; // child agent_group_id → its work/<id> dir
  label: string; // container path label, e.g. the child's group folder
}

export interface LeaderMountInput {
  nasPath: string | undefined;
  isLeader: boolean;
  reports: LeaderReport[];
  /** Injectable for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
}

export function applyLeaderWorkspaceMounts(
  mounts: AdditionalMountConfig[],
  input: LeaderMountInput,
): AdditionalMountConfig[] {
  const { nasPath, isLeader, reports } = input;
  if (!nasPath) return mounts;
  const exists = input.fileExists ?? fs.existsSync;

  // vault: upgrade-only RW for leaders (immutably; never downgrade a static RW).
  const out: AdditionalMountConfig[] = mounts.map((m) =>
    m.containerPath === 'vault' ? { ...m, readonly: m.readonly && !isLeader } : m,
  );

  // team/<report>: each report's work dir, RO. Only what exists; never persisted.
  if (isLeader) {
    for (const r of reports) {
      const containerPath = `team/${r.label}`;
      if (out.some((m) => m.containerPath === containerPath)) continue;
      const hostPath = path.join(nasPath, 'work', r.id);
      if (!exists(hostPath)) continue;
      out.push({ hostPath, containerPath, readonly: true });
    }
  }
  return out;
}
