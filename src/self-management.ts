import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { getClixPaths, initClixHome, readClixConfig, readClixRegistry } from './config-store';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  version: string;
  nodeVersion: string;
  platform: string;
  paths: ReturnType<typeof getClixPaths>;
  npmPrefix?: string;
  npmGlobalBin?: string;
  checks: DoctorCheck[];
}

export async function buildDoctorReport(version: string): Promise<DoctorReport> {
  const paths = getClixPaths();
  const { config } = await initClixHome();
  const registry = await readClixRegistry(paths);
  const npmPrefix = await getNpmPrefix();
  const npmGlobalBin = npmPrefix ? resolveGlobalBin(npmPrefix) : undefined;
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  const checks: DoctorCheck[] = [
    {
      name: 'node',
      ok: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 20,
      detail: `当前 Node 版本：${process.version}`,
    },
    {
      name: 'clix-home',
      ok: true,
      detail: `已就绪：${paths.homeDir}`,
    },
    {
      name: 'config',
      ok: Boolean(config.version),
      detail: `配置文件：${paths.configFilePath}`,
    },
    {
      name: 'registry',
      ok: Boolean(registry.version),
      detail: `已记录 ${Object.keys(registry.clis).length} 个生成 CLI`,
    },
    {
      name: 'npm-prefix',
      ok: Boolean(npmPrefix),
      detail: npmPrefix ? `npm prefix=${npmPrefix}` : '无法读取 npm prefix',
    },
    {
      name: 'global-bin-in-path',
      ok: Boolean(npmGlobalBin && pathEntries.includes(npmGlobalBin)),
      detail: npmGlobalBin
        ? `global bin=${npmGlobalBin}${pathEntries.includes(npmGlobalBin) ? ' 已在 PATH 中' : ' 未在 PATH 中'}`
        : '无法确定 global bin 目录',
    },
  ];

  return {
    version,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    paths,
    npmPrefix,
    npmGlobalBin,
    checks,
  };
}

export async function getPrintablePaths(): Promise<Record<string, string>> {
  const { paths } = await initClixHome();
  return {
    homeDir: paths.homeDir,
    configFilePath: paths.configFilePath,
    registryFilePath: paths.registryFilePath,
    cacheDir: paths.cacheDir,
    logsDir: paths.logsDir,
    pluginsDir: paths.pluginsDir,
    templatesDir: paths.templatesDir,
    appsDir: paths.appsDir,
    cwd: paths.cwd,
    executablePath: paths.executablePath,
  };
}

export async function getResolvedConfig() {
  return readClixConfig();
}

export async function getNpmPrefix(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('npm', ['config', 'get', 'prefix']);
    const value = stdout.trim();
    return value && value !== 'undefined' ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function getGlobalBinDir(): Promise<string | undefined> {
  const npmPrefix = await getNpmPrefix();
  return npmPrefix ? resolveGlobalBin(npmPrefix) : undefined;
}

export function resolveGlobalBin(prefix: string): string {
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}
