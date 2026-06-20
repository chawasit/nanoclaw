import { describe, expect, it } from 'vitest';

import { renderRoleBrief, validateRoleBrief } from './role-brief.js';

const full = {
  reportsTo: 'the MD',
  mandate: 'Run the data pipeline',
  doneWhen: 'daily report ships by 9am',
  toolLimits: 'read-only DB',
  statusExpectation: 'report_status every wake',
};

describe('validateRoleBrief', () => {
  it('accepts a full brief and normalizes it', () => {
    const r = validateRoleBrief(full);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.brief).toMatchObject(full);
  });
  it('accepts a minimal brief (required fields only)', () => {
    const r = validateRoleBrief({ reportsTo: 'MD', mandate: 'do x', doneWhen: 'x done' });
    expect(r.ok).toBe(true);
    expect(r.brief?.toolLimits).toBeUndefined();
  });
  it('rejects when a required field is missing', () => {
    const r = validateRoleBrief({ reportsTo: 'MD', doneWhen: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/mandate/);
    expect(r.brief).toBeUndefined();
  });
  it('rejects empty-string and non-string required fields', () => {
    expect(validateRoleBrief({ reportsTo: 'MD', mandate: '  ', doneWhen: 'x' }).ok).toBe(false);
    expect(validateRoleBrief({ reportsTo: 'MD', mandate: 42, doneWhen: 'x' }).ok).toBe(false);
  });
  it('ignores non-string optionals rather than failing', () => {
    const r = validateRoleBrief({ ...full, toolLimits: 99 });
    expect(r.ok).toBe(true);
    expect(r.brief?.toolLimits).toBeUndefined();
  });
});

describe('renderRoleBrief', () => {
  it('includes the marker, all provided fields, and the precedence line', () => {
    const md = renderRoleBrief(full);
    expect(md).toContain('<!-- role-brief -->');
    expect(md).toContain('Run the data pipeline');
    expect(md).toContain('the MD');
    expect(md).toContain('read-only DB');
    expect(md.toLowerCase()).toContain('override');
  });
  it('omits optional fields that are absent', () => {
    const md = renderRoleBrief({ reportsTo: 'MD', mandate: 'm', doneWhen: 'd' });
    expect(md).not.toContain('Tool limits');
    expect(md).not.toContain('Status expectation');
  });
});
