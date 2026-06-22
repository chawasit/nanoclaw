import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { disallowedToolsForRole, MANAGER_ONLY_BOARD_TOOLS } from "./leader-tools.js";

describe("disallowedToolsForRole", () => {
  it("gates the durable board-write tools for non-leaders (workers)", () => {
    assert.deepEqual(disallowedToolsForRole(false), MANAGER_ONLY_BOARD_TOOLS);
  });
  it("gates nothing for leaders (managers keep the board)", () => {
    assert.deepEqual(disallowedToolsForRole(true), []);
  });
  it("never gates report_status or task_list (status + read stay for all)", () => {
    const gated = disallowedToolsForRole(false);
    assert.ok(!gated.includes("mcp__nanoclaw__report_status"));
    assert.ok(!gated.includes("mcp__nanoclaw__task_list"));
  });
});
