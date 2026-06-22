/**
 * Leader-based tool gating (companion to leader-mounts.ts; dev-log/0057).
 *
 * The durable company task board WRITE tools (`task_create`/`task_update`) are a
 * MANAGER coordination surface — for tracking work ACROSS reports. Workers plan
 * with their own ephemeral `TodoWrite` list + report via `report_status` instead
 * (SOP base-agent-contract / status-reporting). So we DISALLOW the board-write
 * tools for non-leaders. `report_status` (standup) and `task_list` (read) stay for
 * everyone. Recomputed every spawn from the live org graph (like the leader mounts),
 * so promotion/demotion just changes the gate next spawn.
 */

/** Durable task-board WRITE tools reserved for managers (leaders). */
export const MANAGER_ONLY_BOARD_TOOLS = ["mcp__nanoclaw__task_create", "mcp__nanoclaw__task_update"];

/**
 * Tool names to DISALLOW for an agent given its leadership. Non-leaders lose the
 * durable board-write tools; leaders keep everything. Pure + total.
 */
export function disallowedToolsForRole(isLeader: boolean): string[] {
  return isLeader ? [] : [...MANAGER_ONLY_BOARD_TOOLS];
}
