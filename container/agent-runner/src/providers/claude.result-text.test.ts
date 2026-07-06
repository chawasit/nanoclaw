import { describe, it, expect } from 'bun:test';

import { createTurnTextAccumulator, mainAgentAssistantText, resolveTurnText } from './claude.js';

/**
 * These helpers back the "deliver empty-result user text" fix: when a turn's
 * final assistant text shares an assistant message with a background-tool
 * tool_use (e.g. the Workflow tool → immediate async_launched tool_result →
 * turn ends), the SDK `result.result` comes back EMPTY. The provider must fall
 * back to the accumulated MAIN-agent text (parent_tool_use_id === null) so the
 * poll-loop's relaxed-delivery branch can auto-deliver it — while NEVER
 * accumulating background/subagent sidechain text (parent_tool_use_id != null).
 */

function assistantMessage(text: string, parentToolUseId: string | null): unknown {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('mainAgentAssistantText', () => {
  it('extracts concatenated text blocks of a MAIN-agent assistant message', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Workflow ' },
          { type: 'tool_use', id: 'tu_1', name: 'Workflow', input: {} },
          { type: 'text', text: 'launched!' },
        ],
      },
    };
    expect(mainAgentAssistantText(msg)).toBe('Workflow launched!');
  });

  it('returns "" for a SIDECHAIN assistant message (parent_tool_use_id != null)', () => {
    // A background workflow's subagent chatter must never be accumulated.
    expect(mainAgentAssistantText(assistantMessage('subagent progress note', 'tu_bg_1'))).toBe('');
  });

  it('returns "" for non-assistant messages', () => {
    expect(mainAgentAssistantText({ type: 'result', result: 'x' })).toBe('');
    expect(mainAgentAssistantText({ type: 'system', subtype: 'init' })).toBe('');
    expect(mainAgentAssistantText(null)).toBe('');
    expect(mainAgentAssistantText({ type: 'assistant', parent_tool_use_id: null, message: {} })).toBe('');
  });
});

describe('resolveTurnText', () => {
  it('prefers a non-empty SDK result string (regression guard)', () => {
    expect(resolveTurnText('the real SDK result', 'accumulated fallback')).toBe('the real SDK result');
  });

  it('falls back to accumulated main-agent text when the SDK result is empty', () => {
    expect(resolveTurnText('', 'Workflow launched! Watching progress…')).toBe('Workflow launched! Watching progress…');
    expect(resolveTurnText(null, 'Workflow launched!')).toBe('Workflow launched!');
  });

  it('returns null when neither the SDK result nor the accumulated text has content', () => {
    expect(resolveTurnText('', '')).toBeNull();
    expect(resolveTurnText(null, '   ')).toBeNull();
  });
});

describe('createTurnTextAccumulator', () => {
  it('empty SDK result + accumulated main-agent text → resolves to that text', () => {
    const acc = createTurnTextAccumulator();
    acc.observe(assistantMessage('Workflow launched!', null));
    expect(acc.resolve('')).toBe('Workflow launched!');
  });

  it('does NOT accumulate sidechain (background/subagent) text', () => {
    const acc = createTurnTextAccumulator();
    acc.observe(assistantMessage('main narration ', null));
    acc.observe(assistantMessage('SUBAGENT internal chatter', 'tu_bg_1'));
    acc.observe(assistantMessage('continues', null));
    // Only the two main-agent blocks; the sidechain block is dropped.
    expect(acc.resolve('')).toBe('main narration continues');
  });

  it('non-empty SDK result wins even when main-agent text was accumulated (regression)', () => {
    const acc = createTurnTextAccumulator();
    acc.observe(assistantMessage('some narration', null));
    expect(acc.resolve('the SDK result summary')).toBe('the SDK result summary');
  });

  it('resets at the turn boundary — turn N text cannot leak into turn N+1', () => {
    const acc = createTurnTextAccumulator();
    acc.observe(assistantMessage('turn-one text', null));
    expect(acc.resolve('')).toBe('turn-one text');
    // New turn: nothing observed yet, empty result → null (no stale carryover).
    expect(acc.resolve('')).toBeNull();
    // And fresh accumulation in turn 2 is isolated.
    acc.observe(assistantMessage('turn-two text', null));
    expect(acc.resolve('')).toBe('turn-two text');
  });
});
