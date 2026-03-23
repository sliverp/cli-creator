import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { getBuiltCliRecord } from '../src/config-store';
import { buildCli } from '../src/generated-cli';
import type { TuiAdapter, TuiConfirmOptions, TuiInputOptions, TuiSelectOptions } from '../src/tui';

const execFileAsync = promisify(execFile);

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
}

describe('generated cli workflow', () => {
  const originalHome = process.env.CLIX_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CLIX_HOME;
    } else {
      process.env.CLIX_HOME = originalHome;
    }
  });

  it('builds a runnable cli and installs a command shim', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-build-home-'));
    const targetDir = await mkdtemp(path.join(os.tmpdir(), 'clix-build-target-'));
    const installBinDir = await mkdtemp(path.join(os.tmpdir(), 'clix-build-bin-'));
    const fixturePath = path.resolve(__dirname, '../fixtures/sample-api.md');

    const result = await buildCli({
      name: 'samplecli',
      from: fixturePath,
      to: targetDir,
      installBinDir,
      tui: new ScriptedTui(
        [
          'Sample generated CLI',
          'cdb StartCpuExpand',
          'samplecli',
          'cdb.tencentcloudapi.com',
          '/',
          '{"Content-Type":"application/json","X-TC-Action":"StartCpuExpand"}',
        ],
        [true, true, true, true, true, true, true],
        ['POST', 'body', 'body', 'body'],
      ),
    });

    expect(result.shimFilePath).toBe(path.join(installBinDir, 'samplecli'));
    const record = await getBuiltCliRecord('samplecli');
    expect(record?.targetDir).toBe(targetDir);
    expect(record?.commandPath).toEqual(['cdb', 'StartCpuExpand']);

    const { stdout } = await execFileAsync(result.shimFilePath!, [
      'cdb',
      'StartCpuExpand',
      '--ExpandCpu',
      '4',
      '--InstanceId',
      'cdb-himitj11',
      '--Type',
      'manual',
      '--dry-run',
    ]);

    expect(stdout).toContain('https://cdb.tencentcloudapi.com/');
    expect(stdout).toContain('StartCpuExpand');
  });

});
