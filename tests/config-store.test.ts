import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getBuiltCliRecord,
  getClixPaths,
  getConfigValue,
  getImportDefaults,
  initClixHome,
  setConfigValue,
  upsertBuiltCliRecord,
} from '../src/config-store';

describe('clix config store', () => {
  const originalHome = process.env.CLIX_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CLIX_HOME;
    } else {
      process.env.CLIX_HOME = originalHome;
    }
  });

  it('initializes home directories, registry and default config', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-home-'));

    const result = await initClixHome();

    expect(result.created).toBe(true);
    expect(result.config.defaults.importMode).toBe('ai');
    expect(result.config.defaults.outputDir).toBe('.clix-artifacts');
    expect(result.paths.configFilePath).toContain('config.json');
    expect(result.paths.registryFilePath).toContain('registry.json');
    expect(result.paths.appsDir.startsWith(process.env.CLIX_HOME ?? '')).toBe(true);
  });

  it('persists config updates', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-config-'));
    await initClixHome();

    await setConfigValue('defaults.outputDir', '.drafts');
    await setConfigValue('llm.model', 'gpt-test');

    expect(await getConfigValue('defaults.outputDir')).toBe('.drafts');
    expect(await getConfigValue('llm.model')).toBe('gpt-test');
    expect((await getImportDefaults()).outputDir).toBe('.drafts');
  });

  it('stores generated cli records in registry', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-registry-'));
    await initClixHome();

    await upsertBuiltCliRecord({
      name: 'samplecli',
      packageName: 'samplecli',
      targetDir: '/tmp/samplecli',
      manifestFilePath: '/tmp/samplecli/clix.manifest.json',
      entryFilePath: '/tmp/samplecli/bin/samplecli.js',
      commandPath: ['cdb', 'StartCpuExpand'],
      source: '/tmp/source.md',
      builtAt: new Date().toISOString(),
    });

    const record = await getBuiltCliRecord('samplecli');
    expect(record?.packageName).toBe('samplecli');
    expect(record?.commandPath).toEqual(['cdb', 'StartCpuExpand']);
  });

  it('resolves paths from CLIX_HOME override', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-paths-'));

    const paths = getClixPaths();

    expect(paths.homeDir).toBe(process.env.CLIX_HOME);
    expect(paths.cacheDir.startsWith(process.env.CLIX_HOME ?? '')).toBe(true);
    expect(paths.appsDir.startsWith(process.env.CLIX_HOME ?? '')).toBe(true);
  });
});
