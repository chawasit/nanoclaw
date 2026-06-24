import { describe, expect, it } from 'vitest';

import { applyLeaderWorkspaceMounts } from './leader-mounts.js';
import type { AdditionalMountConfig } from './container-config.js';

const NAS = '/srv/company-nas';
// A base mount set that still carries the LEGACY per-agent `work` mount, as an
// existing agent's persisted additional_mounts would (base-profile wrote it before
// the workspace-model redesign). The overlay must strip it.
const base = (): AdditionalMountConfig[] => [
  { hostPath: '/srv/circle/company/vault', containerPath: 'vault', readonly: true },
  { hostPath: `${NAS}/shared`, containerPath: 'shared', readonly: false },
  { hostPath: `${NAS}/work/ag-self`, containerPath: 'work', readonly: false },
];
const vault = (mounts: AdditionalMountConfig[]) => mounts.find((m) => m.containerPath === 'vault');

describe('applyLeaderWorkspaceMounts', () => {
  it('is a no-op when COMPANY_NAS_PATH is unset', () => {
    const m = base();
    const out = applyLeaderWorkspaceMounts(m, { nasPath: undefined, isLeader: true });
    expect(out).toBe(m); // same reference — untouched
  });

  it('strips the retired per-agent `work` mount (existing agents persist it)', () => {
    const out = applyLeaderWorkspaceMounts(base(), { nasPath: NAS, isLeader: false });
    expect(out.some((m) => m.containerPath === 'work')).toBe(false);
    // vault + shared survive.
    expect(out.some((m) => m.containerPath === 'vault')).toBe(true);
    expect(out.some((m) => m.containerPath === 'shared')).toBe(true);
  });

  it('never adds a team/<report> oversight mount (retired — moved to the visualizer)', () => {
    const out = applyLeaderWorkspaceMounts(base(), { nasPath: NAS, isLeader: true });
    expect(out.some((m) => m.containerPath.startsWith('team/'))).toBe(false);
  });

  it('promotes the vault to RW for a leader', () => {
    const out = applyLeaderWorkspaceMounts(base(), { nasPath: NAS, isLeader: true });
    expect(vault(out)?.readonly).toBe(false);
  });

  it('keeps the vault RO for a non-leader', () => {
    const out = applyLeaderWorkspaceMounts(base(), { nasPath: NAS, isLeader: false });
    expect(vault(out)?.readonly).toBe(true);
  });

  it('upgrade-only: never downgrades a manually-granted static RW vault', () => {
    const m = base();
    m[0] = { ...m[0], readonly: false }; // static RW (e.g. the MD with 0 reports)
    const out = applyLeaderWorkspaceMounts(m, { nasPath: NAS, isLeader: false });
    expect(vault(out)?.readonly).toBe(false); // stays RW
  });

  it('does not mutate the input array', () => {
    const m = base();
    applyLeaderWorkspaceMounts(m, { nasPath: NAS, isLeader: true });
    expect(m.length).toBe(3); // original untouched (work still present, vault RO)
    expect(m.some((x) => x.containerPath === 'work')).toBe(true);
    expect(vault(m)?.readonly).toBe(true);
  });
});
