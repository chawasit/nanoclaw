import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoCompactWindowForModel, applyAutoCompactWindow } from './context-window.js';

describe('autoCompactWindowForModel', () => {
  it('elevates glm to 700K, minimax to 300K, qwen to 229376 (256K - 32K)', () => {
    assert.equal(autoCompactWindowForModel('glm-5.2', undefined), '700000');
    assert.equal(autoCompactWindowForModel('minimax-m3', undefined), '300000');
    assert.equal(autoCompactWindowForModel('qwen3.6-35b', undefined), '229376');
  });
  it('leaves local gemma / claude / unknown undefined (165K default downstream)', () => {
    assert.equal(autoCompactWindowForModel('unsloth/gemma-4-26B-A4B-it', undefined), undefined);
    assert.equal(autoCompactWindowForModel('claude-opus-4-8', undefined), undefined);
    assert.equal(autoCompactWindowForModel(undefined, undefined), undefined);
  });
  it('lets an explicit value win (operator override)', () => {
    assert.equal(autoCompactWindowForModel('minimax-m3', '900000'), '900000');
    assert.equal(autoCompactWindowForModel('unsloth/gemma-4', '500000'), '500000');
  });
});

describe('applyAutoCompactWindow', () => {
  it('sets the tier window for a cloud model, preserving other env keys', () => {
    assert.deepEqual(applyAutoCompactWindow({ ANTHROPIC_API_KEY: 'x' }, 'glm-5.2'), {
      ANTHROPIC_API_KEY: 'x',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000',
    });
  });
  it('leaves a local-gemma env untouched (no key added)', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://192.168.1.31:11434' };
    assert.equal(applyAutoCompactWindow(env, 'unsloth/gemma-4'), env);
  });
  it('keeps an explicit window even on a cloud model', () => {
    assert.deepEqual(applyAutoCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000' }, 'glm-5.2'), {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
    });
  });
});
