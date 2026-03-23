import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initClixHome } from '../src/config-store';
import { buildDoctorReport, getPrintablePaths } from '../src/self-management';

describe('clix self management', () => {
  const originalHome = process.env.CLIX_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CLIX_HOME;
    } else {
      process.env.CLIX_HOME = originalHome;
    }
  });

  it('returns clix paths from initialized home', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-self-paths-'));
    await initClixHome();

    const paths = await getPrintablePaths();

    expect(paths.homeDir).toBe(process.env.CLIX_HOME);
    expect(paths.configFilePath.startsWith(process.env.CLIX_HOME ?? '')).toBe(true);
    expect(paths.registryFilePath.startsWith(process.env.CLIX_HOME ?? '')).toBe(true);
    expect(paths.appsDir.startsWith(process.env.CLIX_HOME ?? '')).toBe(true);
  });

  it('builds doctor report with checks', async () => {
    process.env.CLIX_HOME = await mkdtemp(path.join(os.tmpdir(), 'clix-doctor-'));

    const report = await buildDoctorReport('0.1.0-test');

    expect(report.version).toBe('0.1.0-test');
    expect(report.checks.some((item) => item.name === 'clix-home')).toBe(true);
    expect(report.checks.some((item) => item.name === 'registry')).toBe(true);
    expect(report.checks.some((item) => item.name === 'config')).toBe(true);
  });
});
