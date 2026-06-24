import { describe, it, expect } from 'vitest';
import {
  isProxyModel,
  proxyEnvForModel,
  applyProxyEnv,
  shouldBlockAnthropicForProxy,
  type ProxyHost,
} from './proxy-env.js';

const HOST: ProxyHost = { baseUrl: 'http://192.168.1.37:4000', apiKey: 'sk-test-master' };
const OVERLAY = {
  ANTHROPIC_BASE_URL: 'http://192.168.1.37:4000',
  ANTHROPIC_API_KEY: 'sk-test-master',
  NO_PROXY: '192.168.1.37',
  no_proxy: '192.168.1.37',
};

describe('isProxyModel', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['glm-5.2', true],
    ['minimax-m3', true],
    ['gemini-3.1-pro', true],
    ['gpt-5.5', true],
    ['GLM-5.2', true], // case-insensitive
    ['zai-org/GLM-5.2', true], // vendor/-prefixed still matches glm
    ['openai/gpt-5.4-mini', true],
    ['unsloth/gemma-4-26B-A4B-it', false], // local gemma (vendor-prefixed)
    ['gemma-4', false],
    ['claude-opus-4-8', false],
    ['claude-sonnet-4-6', false],
    [undefined, false],
    ['', false],
  ];
  for (const [model, expected] of cases) {
    it(`${model ?? '(undefined)'} -> ${expected}`, () => {
      expect(isProxyModel(model)).toBe(expected);
    });
  }
});

describe('proxyEnvForModel', () => {
  it('returns the overlay for each proxy family when host config is present', () => {
    for (const m of ['glm-5.2', 'minimax-m3', 'gemini-3.1-pro', 'gpt-5.5', 'zai-org/GLM-5.2']) {
      expect(proxyEnvForModel(m, HOST)).toEqual(OVERLAY);
    }
  });
  it('returns null for local gemma / unsloth / claude', () => {
    expect(proxyEnvForModel('gemma-4', HOST)).toBeNull();
    expect(proxyEnvForModel('unsloth/gemma-4-26B-A4B-it', HOST)).toBeNull();
    expect(proxyEnvForModel('claude-opus-4-8', HOST)).toBeNull();
  });
  it('returns null when host config is absent (env-gated no-op)', () => {
    expect(proxyEnvForModel('glm-5.2', undefined)).toBeNull();
    expect(proxyEnvForModel('glm-5.2', { baseUrl: 'http://x:4000' })).toBeNull(); // no key
    expect(proxyEnvForModel('glm-5.2', { apiKey: 'k' })).toBeNull(); // no base url
  });
  it('uses hostname only for NO_PROXY (strips port)', () => {
    const o = proxyEnvForModel('glm-5.2', { baseUrl: 'http://10.0.0.5:4000', apiKey: 'k' });
    expect(o?.NO_PROXY).toBe('10.0.0.5');
    expect(o?.no_proxy).toBe('10.0.0.5');
  });
});

describe('applyProxyEnv', () => {
  it('injects the overlay into an empty env for a proxy model', () => {
    expect(applyProxyEnv({}, 'gemini-3.1-pro', HOST)).toEqual(OVERLAY);
  });
  it('merges into existing non-conflicting env keys', () => {
    expect(applyProxyEnv({ FOO: 'bar' }, 'glm-5.2', HOST)).toEqual({ FOO: 'bar', ...OVERLAY });
  });
  it('leaves env UNCHANGED when an explicit ANTHROPIC_BASE_URL is set (explicit wins)', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://192.168.1.31:11434', ANTHROPIC_API_KEY: 'ollama' };
    expect(applyProxyEnv(env, 'glm-5.2', HOST)).toBe(env); // same reference
  });
  it('leaves env UNCHANGED for a local/gemma model', () => {
    const env = { FOO: 'bar' };
    expect(applyProxyEnv(env, 'unsloth/gemma-4', HOST)).toBe(env);
  });
  it('leaves env UNCHANGED when host config is absent', () => {
    const env = { FOO: 'bar' };
    expect(applyProxyEnv(env, 'glm-5.2', undefined)).toBe(env);
  });
  it('handles undefined env', () => {
    expect(applyProxyEnv(undefined, 'glm-5.2', HOST)).toEqual(OVERLAY);
  });
});

describe('shouldBlockAnthropicForProxy', () => {
  it('true exactly when the overlay would be injected', () => {
    expect(shouldBlockAnthropicForProxy({}, 'glm-5.2', HOST)).toBe(true);
    expect(shouldBlockAnthropicForProxy(undefined, 'gpt-5.5', HOST)).toBe(true);
  });
  it('false for explicit base url, local model, or absent host', () => {
    expect(shouldBlockAnthropicForProxy({ ANTHROPIC_BASE_URL: 'http://x' }, 'glm-5.2', HOST)).toBe(false);
    expect(shouldBlockAnthropicForProxy({}, 'gemma-4', HOST)).toBe(false);
    expect(shouldBlockAnthropicForProxy({}, 'glm-5.2', undefined)).toBe(false);
  });
});
