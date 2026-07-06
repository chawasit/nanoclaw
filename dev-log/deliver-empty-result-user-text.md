# Deliver empty-result user text (provider-side fallback)

> Spine-repo branch `feat/deliver-empty-result-text` (off `company`). This file
> travels with the code; the MERGER files it as the next numbered Circle
> `dev-log/NNNN-deliver-empty-result-user-text.md`. Deploy = merger, lands on
> the next CoS respawn (bind-mounted `container/agent-runner/src`).

## Goal

A user-facing agent (CoS) on the Claude Agent SDK narrates ("Workflow
launched! …") and the narration never reaches the Circle user, even though it
exists in the transcript. Recover it without leaking any internal/marker text.

## Root cause

`translateEvents` (`container/agent-runner/src/providers/claude.ts`) had no
`message.type === 'assistant'` case — assistant text was discarded and the
delivered reply text was sourced 100% from the SDK `result` message's `result`
string. When a turn's final assistant text sits in the SAME assistant message
as a background-tool `tool_use` (the `Workflow` tool returns an immediate
`async_launched` tool_result and the turn then ends), `result.result` comes
back EMPTY → the poll-loop `scratchpad` is empty → `undelivered === false` →
NEITHER the relaxed-delivery auto-deliver branch (`poll-loop.ts` ~L589) NOR the
nudge branch (~L620) runs. The narration is lost.

## The fix (provider-side only; poll-loop branch logic unchanged)

Three small exported helpers in `claude.ts`, wired into `translateEvents`:

- `mainAgentAssistantText(message)` — concatenated text blocks of a MAIN-agent
  assistant message (`parent_tool_use_id === null`). Sidechain/subagent
  messages (`parent_tool_use_id != null`) return `''`, so a running background
  workflow's subagent chatter is NEVER accumulated and can never leak.
  (Verified `SDKAssistantMessage` shape in the installed SDK d.ts:
  `type:'assistant'`, `message: BetaMessage`, `parent_tool_use_id: string|null`.)
- `resolveTurnText(sdkText, accumulated)` — prefer a NON-empty SDK string
  (regression guard: `result` summary or joined `errors[]`); else fall back to
  the trimmed accumulated main-agent text; else `null`.
- `createTurnTextAccumulator()` — stateful `{observe, resolve}`. `observe` folds
  each SDK message (main-agent text only); `resolve` returns the surfaced turn
  text and RESETS, so turn N's text cannot leak into turn N+1.

`translateEvents` now calls `turnText.observe(message)` for every message and,
on the `result` message, yields `text: turnText.resolve(sdkText)` (was
`text: sdkText`). `isError` still comes only from the SDK. Reset happens only on
`message.type === 'result'` (not on `compact_boundary`, which is mid-turn).

## Blast-radius enumeration (the load-bearing part)

The fix flips every empty-`result`-with-accumulated-text user-lane turn from
"delivers nothing" to "auto-delivers the accumulated text." The guarantee — no
internal/marker text newly leaks — holds STRUCTURALLY, not by duplicating
guards: the poll-loop derives BOTH the auto-deliver branch (`undelivered &&
isUserLane`) and the nudge branch (`undelivered && !isUserLane`) from the SAME
`undelivered` var, which already applies `stripInternalTags` + the
`[[SLEEP_SUMMARY_COMPLETE]]` marker check to `event.text`. The fix only
POPULATES `event.text` for empty-result turns and changes nothing downstream,
so every existing content exemption applies identically — auto-deliver can
never be more permissive than the nudge-suppression inverse.

Turn types that produce an empty SDK `result` + non-empty accumulated
main-agent text, and their disposition:

| Turn type | Lane | Now |
|---|---|---|
| Background-tool launch narration ("Workflow launched!") | user | AUTO-DELIVERS (the fix) |
| Same, but agent also called `send_message` | user | `deliveredThisTurn` true → not undelivered, no double-send |
| `<internal>…</internal>`-only scratchpad | any | `stripInternalTags` empties scratchpad → not delivered, not nudged |
| Sleep-orchestrator EOD `[[SLEEP_SUMMARY_COMPLETE]]` | any | marker → `undelivered` false → not delivered, not nudged |
| Plain narration co-located with bg tool_use | peer/`agent` | NUDGE branch (capped at MAX_NUDGES_PER_STREAM=5, re-arm latch) |
| Genuinely empty turn (null text) | any | nothing (accumulator empty → `resolve` null) |
| `<message>`-wrapped fallback prose | user | delivers verbatim — pre-existing for non-empty results; it is the agent's own user-directed prose, not internal/marker content — within the guarantee |

Peer-lane note: an empty-result peer turn that produced main-agent text now
routes to the NUDGE branch (was: nothing). That is consistent with the intended
nudge semantics (an undelivered reply) and is capped, so acceptable.

Background-workflow COMPLETION re-invokes the agent → a fresh `result` with its
own text; the same fix makes that summary deliver robustly (no extra work).

## Tests

- `providers/claude.result-text.test.ts` (NEW, 10 tests): empty result +
  accumulated text → that text; SIDECHAIN (`parent_tool_use_id != null`) NOT
  accumulated; non-empty result wins (regression); accumulator resets at the
  turn boundary; `resolveTurnText`/`mainAgentAssistantText` unit cases.
- `poll-loop.test.ts` (NEW block, 4 tests): user-lane fallback narration →
  ONE outbound row + no nudge; user-lane `[[SLEEP_SUMMARY_COMPLETE]]` → NO row;
  user-lane `<internal>`-only → NO row; null-text → nothing.

## Result

- Branch `feat/deliver-empty-result-text` (off `company`).
- Files: `container/agent-runner/src/providers/claude.ts` (+helpers, wired
  `translateEvents`), `container/agent-runner/src/providers/claude.result-text.test.ts`
  (new), `container/agent-runner/src/poll-loop.test.ts` (new describe block).
  No poll-loop.ts source change; no shared-config/migration edits.
- Full agent-runner suite: 190 pass / 0 fail (18 files). `tsc --noEmit` clean.
- Deploy = merger, lands on the next CoS respawn (NOT while a live workflow runs).
