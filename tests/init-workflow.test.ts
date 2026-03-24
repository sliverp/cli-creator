import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readClixConfig } from '../src/config-store';
import { runInitWizard } from '../src/init-workflow';
import type { TuiAdapter, TuiConfirmOptions, TuiInputOptions, TuiMultiSelectOptions, TuiSelectOptions } from '../src/tui';

class ScriptedTui implements TuiAdapter {
  constructor(
    private readonly inputs: string[],
    private readonly confirms: boolean[],
    private readonly selects: string[],
  ) {}

  async input(_options: TuiInputOptions): Promise<string> {
    const value = this.inputs.shift();
    if (value === undefined) {
      throw new Error('missing scripted input');
    }
    return value;
  }

  async confirm(_options: TuiConfirmOptions): Promise<boolean> {
    const value = this.confirms.shift();
    if (value === undefined) {
      throw new Error('missing scripted confirm');
    }
    return value;
  }

  async select<T extends string>(_options: TuiSelectOptions<T>): Promise<T> {
    const value = this.selects.shift();
    if (value === undefined) {
      throw new Error('missing scripted select');
    }
    return value as T;
  }

  async multiSelect<T extends string>(_options: TuiMultiSelectOptions<T>): Promise<T[]> {
    return [];
  }
}

describe('clix init workflow', () => {
  const originalHome = process.env.CLIX_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CLIX_HOME;
    } else {
      process.env.CLIX_HOME = originalHome;
    }
  });

  it('writes llm config with env var api key', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-init-'));

    // selects: provider → model → apiKey mode(env) → npmAccess
    // inputs: baseUrl → envName → packageScope → publishTag
    const result = await runInitWizard({
      tui: new ScriptedTui(
        ['https://api.example.com/v1', 'OPENAI_TEST_KEY', '@demo-scope', 'beta'],
        [true],
        ['openai', 'gpt-5', 'env', 'public'],
      ),
    });

    const config = await readClixConfig();
    expect(result.saved).toBe(true);
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-5');
    expect(config.llm.baseUrl).toBe('https://api.example.com/v1');
    expect(config.llm.apiKeyEnvName).toBe('OPENAI_TEST_KEY');
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.defaults.packageScope).toBe('@demo-scope');
    expect(config.defaults.publishTag).toBe('beta');
    expect(config.defaults.npmAccess).toBe('public');
  });

  it('writes llm config with direct api key', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-init-'));

    // selects: provider → model → apiKey mode(direct) → npmAccess
    // inputs: baseUrl → apiKey → packageScope → publishTag
    const result = await runInitWizard({
      tui: new ScriptedTui(
        ['', 'sk-test-key-12345', '', 'latest'],
        [true],
        ['deepseek', 'deepseek-chat', 'direct', 'public'],
      ),
    });

    const config = await readClixConfig();
    expect(result.saved).toBe(true);
    expect(config.llm.provider).toBe('deepseek');
    expect(config.llm.model).toBe('deepseek-chat');
    expect(config.llm.apiKey).toBe('sk-test-key-12345');
    expect(config.llm.apiKeyEnvName).toBeUndefined();
  });

  it('allows providers without api key (skip)', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-init-'));

    // selects: provider → model → apiKey mode(skip) → npmAccess
    // inputs: baseUrl → packageScope → publishTag
    await runInitWizard({
      tui: new ScriptedTui(
        ['http://127.0.0.1:11434/v1', '', 'latest'],
        [true],
        ['ollama', 'qwen2.5:14b', 'skip', 'public'],
      ),
    });

    const config = await readClixConfig();
    expect(config.llm.provider).toBe('ollama');
    expect(config.llm.model).toBe('qwen2.5:14b');
    expect(config.llm.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.llm.apiKeyEnvName).toBeUndefined();
    expect(config.llm.apiKey).toBeUndefined();
  });
});
