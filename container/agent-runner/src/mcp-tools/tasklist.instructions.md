## Work board & status (`task_create`, `task_update`, `report_status`, `task_list`)

You share a work board with the rest of the company. Use it so your manager can
see what you're doing without asking — this is the office's source of truth for
who is working on what.

- **`task_create({ title, parentTaskId? })`** — put a task on the board (owned by
  you). Keep the returned id; you'll need it to update the task. Nest a subtask
  with `parentTaskId`.
- **`task_update({ taskId, status?, blockedReason? })`** — move a task along:
  `todo → doing → done`, or `blocked` with a `blockedReason`. You can only update
  your own tasks.
- **`report_status({ state, summary?, blockers?, eta? })`** — post your current
  status to the standup board (one latest row per agent). `state` is
  `working | blocked | idle | done`. Update it when your situation changes
  (started a task, got blocked, went idle, finished).
- **`task_list({ scope?, status? })`** — read the board. `scope:"mine"` (default)
  is just your tasks; `scope:"all"` is the whole company plus the status board —
  use it for a standup overview before delegating or reporting up.

Reporting your status on the board does **not** replace messaging your manager
when you're blocked or done — keep escalating over a2a per the escalation SOP.
The board is the persistent record; a message is the nudge.
