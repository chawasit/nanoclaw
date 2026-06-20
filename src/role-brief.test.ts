import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let TMP = "";
vi.mock("./config.js", () => ({
  get GROUPS_DIR() {
    return TMP;
  },
}));
vi.mock("./log.js", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { renderRoleBrief, seedRoleBrief, validateRoleBrief } from "./role-brief.js";

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rolebrief-"));
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const group = (folder: string) => ({ id: "ag-x", folder }) as never;
const localFile = (folder: string) => path.join(TMP, folder, "CLAUDE.local.md");
const full = {
  reportsTo: "the MD",
  mandate: "Run the data pipeline",
  doneWhen: "daily report ships by 9am",
  toolLimits: "read-only DB",
  statusExpectation: "report_status every wake",
};

describe("validateRoleBrief", () => {
  it("accepts a full brief and normalizes it", () => {
    const r = validateRoleBrief(full);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.brief).toMatchObject(full);
  });
  it("accepts a minimal brief (required fields only)", () => {
    const r = validateRoleBrief({ reportsTo: "MD", mandate: "do x", doneWhen: "x done" });
    expect(r.ok).toBe(true);
    expect(r.brief?.toolLimits).toBeUndefined();
  });
  it("rejects when a required field is missing", () => {
    const r = validateRoleBrief({ reportsTo: "MD", doneWhen: "x" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/mandate/);
    expect(r.brief).toBeUndefined();
  });
  it("rejects empty-string and non-string required fields", () => {
    expect(validateRoleBrief({ reportsTo: "MD", mandate: "  ", doneWhen: "x" }).ok).toBe(false);
    expect(validateRoleBrief({ reportsTo: "MD", mandate: 42, doneWhen: "x" }).ok).toBe(false);
  });
  it("ignores non-string optionals rather than failing", () => {
    const r = validateRoleBrief({ ...full, toolLimits: 99 });
    expect(r.ok).toBe(true);
    expect(r.brief?.toolLimits).toBeUndefined();
  });
});

describe("renderRoleBrief", () => {
  it("includes the marker, all provided fields, and the precedence line", () => {
    const md = renderRoleBrief(full);
    expect(md).toContain("<!-- role-brief -->");
    expect(md).toContain("Run the data pipeline");
    expect(md).toContain("the MD");
    expect(md).toContain("read-only DB");
    expect(md.toLowerCase()).toContain("override");
  });
  it("omits optional fields that are absent", () => {
    const md = renderRoleBrief({ reportsTo: "MD", mandate: "m", doneWhen: "d" });
    expect(md).not.toContain("Tool limits");
    expect(md).not.toContain("Status expectation");
  });
});

describe("seedRoleBrief", () => {
  it("appends the brief, preserving existing content above it", () => {
    fs.mkdirSync(path.join(TMP, "w1"), { recursive: true });
    fs.writeFileSync(localFile("w1"), "Pre-existing note.\n");
    seedRoleBrief(group("w1"), full);
    const out = fs.readFileSync(localFile("w1"), "utf8");
    expect(out).toContain("Pre-existing note.");
    expect(out).toContain("<!-- role-brief -->");
    expect(out.indexOf("Pre-existing note.")).toBeLessThan(out.indexOf("role-brief"));
  });
  it("creates the file when none exists", () => {
    seedRoleBrief(group("w2"), full);
    expect(fs.readFileSync(localFile("w2"), "utf8")).toContain("Run the data pipeline");
  });
  it("is idempotent (marker guard — never double-writes or re-renders)", () => {
    seedRoleBrief(group("w3"), full);
    const a = fs.readFileSync(localFile("w3"), "utf8");
    seedRoleBrief(group("w3"), { ...full, mandate: "DIFFERENT" });
    const b = fs.readFileSync(localFile("w3"), "utf8");
    expect(b).toBe(a);
    expect(b.split("<!-- role-brief -->").length - 1).toBe(1);
  });
});
