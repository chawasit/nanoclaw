## Showing interactive UI to your user — the Surface UI manual

When you want the user to click a button, pick from choices, fill in a field, or confirm something, do NOT use any card or question tool. Instead, emit a fenced **a2ui** block inside your normal reply. Circle renders it as real interactive UI, and the user's click/submit comes back to you as a machine-readable action on your NEXT turn — it does NOT block your current turn.

### How to emit a surface

Write a fenced ` ```a2ui ` block containing ONE JSON object. You may write normal prose before or after it (the prose is shown as a message, the block as the UI):

```a2ui
{ "op": "create", "surfaceId": "pick-slot-1",
  "components": [
    { "type": "Text", "text": "Which time works?" },
    { "type": "Select", "id": "slot", "label": "Time slot", "options": ["9:00", "13:00", "16:00"] },
    { "type": "Button", "text": "Confirm", "action": { "event": "submit" } }
  ],
  "dataModel": { "slot": null } }
```

- `op` — `"create"` (new), `"update"` (replace one you already sent, reuse its `surfaceId`), or `"delete"`.
- `surfaceId` — a short unique id YOU choose; it is echoed back with the user's answer.
- `components` — an array from the catalog below. Nothing else is allowed: an unknown component type makes the WHOLE block fall back to plain text (fail-closed), so stick to the catalog exactly.
- `dataModel` — optional initial values for bound inputs, keyed by their `id`.

### Component catalog (the ONLY allowed components)

- **Text** — `{ "type": "Text", "text": "…" }` — a line of static text (never HTML).
- **Button** — `{ "type": "Button", "text": "Confirm", "action": { "event": "submit" } }`. `action.event` is the string echoed back when the button is clicked. It may also carry a flat `data` object of primitives, e.g. two buttons sharing one `event` but different `{ "choice": "A" }` / `{ "choice": "B" }`: `{ "type": "Button", "text": "A", "action": { "event": "pick", "data": { "choice": "A" } } }`.
- **Select** — `{ "type": "Select", "id": "slot", "options": ["A", "B"], "label": "…" }` — single choice. `id` is the key the chosen value comes back under. `label` is optional.
- **TextField** — `{ "type": "TextField", "id": "note", "label": "…", "placeholder": "…" }` — free text. `label`/`placeholder` optional.
- **DateTimeInput** — `{ "type": "DateTimeInput", "id": "when", "label": "…" }` — a date/time. `label` optional.
- **Card** — `{ "type": "Card", "title": "…", "children": [ …components… ] }` — a titled container. `title` optional.
- **Row** — `{ "type": "Row", "children": [ …components… ] }` — a horizontal group.

### Getting the answer

When the user acts, on your NEXT turn you receive a machine-readable `a2ui-action` line, e.g. `{ "surfaceId": "pick-slot-1", "event": "submit", "data": { "slot": "13:00" } }`. Read `event` (which button was clicked) and `data` (the bound inputs by their `id`). Each surface is **single-use** — it is consumed after one answer. To change a surface, emit `op:"update"` with the SAME `surfaceId`; to remove it, `op:"delete"`.

### Rules

- Use ONLY the components above — no raw HTML/JS, no other `type` names (they fail closed to plain text).
- The user's returned `event` must be one you declared on a Button, and each returned `data` key must be a component `id` (or a Button `action.data` key) — otherwise the answer is rejected.
- Prefer a plain message when you don't actually need a click or input; reach for a surface only when you need a decision, a choice, or typed input.
