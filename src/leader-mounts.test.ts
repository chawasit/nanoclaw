import { describe, expect, it } from 'vitest';

import { applyLeaderWorkspaceMounts } from './leader-mounts.js';
import type { AdditionalMountConfig } from './container-config.js';

const NAS = '/srv/company-nas';
const base = (): AdditionalMountConfig[] => [
  { hostPath: '/srv/circle/company/vault', containerPath: 'vault', readonly: true },
  { hostPath: `${NAS}/shared`, containerPath: 'shared', readonly: false },
  { hostPath: `${NAS}/work/ag-self`, containerPath: 'work', readonly: false },
];
const vault = (mounts: AdditionalMountConfig[]) => mounts.find((m) => m.containerPath === 'vault');
const allYes = () => true;

describe('applyLeaderWorkspaceMounts', () => {
  it('is a no-op when COMPANY_NAS_PATH is unset', () => {
    const m = base();
    const out = applyLeaderWorkspaceMounts(m, { nasPath: undefined, isLeader: true, reports: [] });
    expect(out).toBe(m); // same reference — untouched
  });

  it('promotes the vault to RW for a leader', () => {
    const out = applyLeaderWorkspaceMounts(base(), { nasPath: NAS, isLeader: true, reports: [] });
    expect(vault(out)?.readonly).toBe(false);
  });

  it('keeps the vault RO for a non-leader', () => {
    const out = applyLeaderWorkspaceMounts(base(), { nasPath: NAS, isLeader: false, reports: [] });
    expect(vault(out)?.readonly).toBe(true);
  });

  it('upgrade-only: never downgrades a manually-granted static RW vault', () => {
    const m = base();
    m[0] = { ...m[0], readonly: false }; // static RW (e.g. the MD with 0 reports)
    const out = applyLeaderWorkspaceMounts(m, { nasPath: NAS, isLeader: false, reports: [] });
    expect(vault(out)?.readonly).toBe(false); // stays RW
  });

  it('adds a team/<label> RO mount per report whose work dir exists', () => {
    const out = applyLeaderWorkspaceMounts(base(), {
      nasPath: NAS,
      isLeader: true,
      reports: [
        { id: 'ag-md', label: 'managing-director' },
        { id: 'ag-coffee', label: 'coffee-research' },
      ],
      fileExists: allYes,
    });
    expect(out).toContainEqual({ hostPath: `${NAS}/work/ag-md`, containerPath: 'team/managing-director', readonly: true });
    expect(out).toContainEqual({ hostPath: `${NAS}/work/ag-coffee`, containerPath: 'team/coffee-research', readonly: true });
  });

  it('skips a report whose work dir does not exist (no rejected-mount noise)', () => {
    const out = applyLeaderWorkspaceMounts(base(), {
      nasPath: NAS,
      isLeader: true,
      reports: [{ id: 'ag-gone', label: 'gone' }],
      fileExists: () => false,
    });
    expect(out.some((m) => m.containerPath === 'team/gone')).toBe(false);
  });

  it('does not add team mounts for a non-leader even if reports are passed', () => {
    const out = applyLeaderWorkspaceMounts(base(), {
      nasPath: NAS,
      isLeader: false,
      reports: [{ id: 'ag-x', label: 'x' }],
      fileExists: allYes,
    });
    expect(out.some((m) => m.containerPath.startsWith('team/'))).toBe(false);
  });

  it('is idempotent — does not duplicate an existing team mount', () => {
    const m = [...base(), { hostPath: `${NAS}/work/ag-md`, containerPath: 'team/managing-director', readonly: true }];
    const out = applyLeaderWorkspaceMounts(m, {
      nasPath: NAS,
      isLeader: true,
      reports: [{ id: 'ag-md', label: 'managing-director' }],
      fileExists: allYes,
    });
    expect(out.filter((x) => x.containerPath === 'team/managing-director').length).toBe(1);
  });

  it('does not mutate the input array', () => {
    const m = base();
    applyLeaderWorkspaceMounts(m, { nasPath: NAS, isLeader: true, reports: [{ id: 'a', label: 'a' }], fileExists: allYes });
    expect(m.length).toBe(3); // original untouched
    expect(vault(m)?.readonly).toBe(true);
  });
});
