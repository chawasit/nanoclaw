/**
 * Task-list module — shared work board + per-agent status board.
 *
 * Registers three delivery-action handlers. The container's tasklist MCP tools
 * (container/agent-runner/src/mcp-tools/tasklist.ts) write system messages with
 * these actions; the host applies them to the standalone data/tasklist/tasks.db.
 *   - task_create   → insert a task (owned by the calling agent)
 *   - task_update   → patch status / blocked_reason on an owned task
 *   - report_status → upsert the agent's latest status (the standup row)
 *
 * Reads (task_list) don't go through the bus — the bus is one-way and can't
 * return data mid-turn. Instead the DB is mounted read-only into containers;
 * see db.ts and the container tool.
 *
 * report_status only persists the row here. The push to a manager is left to
 * native a2a-to-parent (the status-reporting SOP) so v1 stays lean.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleReportStatus, handleTaskCreate, handleTaskUpdate } from './actions.js';
import { initTasklistDb } from './db.js';

// Eagerly create data/tasklist/ + tasks.db at import (host boot, before any
// container spawns) so the read-only mount always has a directory + file.
// Imports in src/index.ts run before main(), and spawns happen during main's
// message handling — so the ordering holds.
initTasklistDb();

registerDeliveryAction('task_create', handleTaskCreate);
registerDeliveryAction('task_update', handleTaskUpdate);
registerDeliveryAction('report_status', handleReportStatus);
