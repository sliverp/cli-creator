import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ImportMode } from './types';
import { fileExists } from './utils';

export interface ClixPaths {
  homeDir: string;
  configFilePath: string;
  registryFilePath: string;
  cacheDir: string;
  logsDir: string;
  pluginsDir: string;
  templatesDir: string;
  appsDir: string;
  cwd: string;
  executablePath: string;
}

export interface ClixConfig {
  version: 1;
  createdAt: string;
  updatedAt: string;
  defaults: {
    importMode: ImportMode;
    outputDir: string;
    publishTag: string;
    npmAccess: 'public' | 'restricted';
    packageScope?: string;
  };
  llm: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKeyEnvName?: string;
    apiKey?: string;
  };
}

export interface BuiltCliRecord {
  name: string;
  packageName: string;
  targetDir: string;
  manifestFilePath: string;
  entryFilePath: string;
  shimFilePath?: string;
  commandPath: string[];
  source: string;
  builtAt: string;
  publishedAt?: string;
}

export interface ClixRegistry {
  version: 1;
  updatedAt: string;
  clis: Record<string, BuiltCliRecord>;
}

export function resolveClixHomeDir(): string {
  const customHome = process.env.CLIX_HOME?.trim();
  return customHome ? path.resolve(customHome) : path.join(os.homedir(), '.clix');
}

export function getClixPaths(): ClixPaths {
  const homeDir = resolveClixHomeDir();
  return {
    homeDir,
    configFilePath: path.join(homeDir, 'config.json'),
    registryFilePath: path.join(homeDir, 'registry.json'),
    cacheDir: path.join(homeDir, 'cache'),
    logsDir: path.join(homeDir, 'logs'),
    pluginsDir: path.join(homeDir, 'plugins'),
    templatesDir: path.join(homeDir, 'templates'),
    appsDir: path.join(homeDir, 'apps'),
    cwd: process.cwd(),
    executablePath: process.argv[1] ? path.resolve(process.argv[1]) : process.execPath,
  };
}

export function createDefaultConfig(): ClixConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    defaults: {
      importMode: 'ai',
      outputDir: '.clix-artifacts',
      publishTag: 'latest',
      npmAccess: 'public',
    },
    llm: {
      provider: 'openai',
      model: 'gpt-5',
      apiKeyEnvName: 'OPENAI_API_KEY',
    },
  };
}

export function createDefaultRegistry(): ClixRegistry {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    clis: {},
  };
}

function inferApiKeyEnvName(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'azure-openai':
      return 'AZURE_OPENAI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    case 'qwen':
      return 'DASHSCOPE_API_KEY';
    case 'kimi':
      return 'MOONSHOT_API_KEY';
    case 'zhipu':
      return 'ZHIPUAI_API_KEY';
    case 'ollama':
    case 'custom':
      return undefined;
    case 'openai':
    default:
      return 'OPENAI_API_KEY';
  }
}

export async function initClixHome(): Promise<{ paths: ClixPaths; config: ClixConfig; created: boolean }> {
  const paths = getClixPaths();
  await Promise.all([
    mkdir(paths.homeDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.pluginsDir, { recursive: true }),
    mkdir(paths.templatesDir, { recursive: true }),
    mkdir(paths.appsDir, { recursive: true }),
  ]);

  const configExists = await fileExists(paths.configFilePath);
  if (!configExists) {
    await writeConfig(createDefaultConfig(), paths);
  }

  const registryExists = await fileExists(paths.registryFilePath);
  if (!registryExists) {
    await writeRegistry(createDefaultRegistry(), paths);
  }

  return {
    paths,
    config: await readClixConfig(paths),
    created: !configExists,
  };
}

export async function readClixConfig(paths = getClixPaths()): Promise<ClixConfig> {
  if (!(await fileExists(paths.configFilePath))) {
    const config = createDefaultConfig();
    await writeConfig(config, paths);
    return config;
  }

  const raw = await readFile(paths.configFilePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ClixConfig>;
  const defaultConfig = createDefaultConfig();
  const parsedLlm: Partial<ClixConfig['llm']> = parsed.llm ?? {};
  const llmProvider = parsedLlm.provider ?? defaultConfig.llm.provider;

  return {
    ...defaultConfig,
    ...parsed,
    defaults: {
      ...defaultConfig.defaults,
      ...(parsed.defaults ?? {}),
    },
    llm: {
      ...defaultConfig.llm,
      ...parsedLlm,
      apiKeyEnvName: parsedLlm.apiKey
        ? undefined
        : Object.prototype.hasOwnProperty.call(parsedLlm, 'apiKeyEnvName')
          ? parsedLlm.apiKeyEnvName
          : inferApiKeyEnvName(llmProvider),
    },
  };
}

export async function writeConfig(config: ClixConfig, paths = getClixPaths()): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true });
  await writeFile(paths.configFilePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function readClixRegistry(paths = getClixPaths()): Promise<ClixRegistry> {
  if (!(await fileExists(paths.registryFilePath))) {
    const registry = createDefaultRegistry();
    await writeRegistry(registry, paths);
    return registry;
  }

  const raw = await readFile(paths.registryFilePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ClixRegistry>;
  return {
    ...createDefaultRegistry(),
    ...parsed,
    clis: {
      ...createDefaultRegistry().clis,
      ...(parsed.clis ?? {}),
    },
  };
}

export async function writeRegistry(registry: ClixRegistry, paths = getClixPaths()): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true });
  await writeFile(paths.registryFilePath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

export async function upsertBuiltCliRecord(record: BuiltCliRecord, paths = getClixPaths()): Promise<void> {
  const registry = await readClixRegistry(paths);
  registry.clis[record.name] = record;
  registry.updatedAt = new Date().toISOString();
  await writeRegistry(registry, paths);
}

export async function getBuiltCliRecord(name: string, paths = getClixPaths()): Promise<BuiltCliRecord | undefined> {
  const registry = await readClixRegistry(paths);
  return registry.clis[name];
}

export async function listBuiltCliRecords(paths = getClixPaths()): Promise<BuiltCliRecord[]> {
  const registry = await readClixRegistry(paths);
  return Object.values(registry.clis).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getImportDefaults(): Promise<ClixConfig['defaults']> {
  const { config } = await initClixHome();
  return config.defaults;
}

export async function listConfigEntries(): Promise<Record<string, unknown>> {
  const { config } = await initClixHome();
  return flattenObject(config as unknown as Record<string, unknown>);
}

export async function getConfigValue(key: string): Promise<unknown> {
  const { config } = await initClixHome();
  return getByPath(config, key);
}

export async function setConfigValue(key: string, rawValue: string): Promise<ClixConfig> {
  const { config, paths } = await initClixHome();
  const nextConfig = structuredClone(config);
  setByPath(nextConfig as unknown as Record<string, unknown>, key, parseConfigValue(rawValue));
  nextConfig.updatedAt = new Date().toISOString();
  await writeConfig(nextConfig, paths);
  return nextConfig;
}

function parseConfigValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return rawValue;
  }
}

function getByPath(target: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, target);
}

function setByPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('配置 key 不能为空');
  }

  let current: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

function flattenObject(input: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  return Object.entries(input).reduce<Record<string, unknown>>((acc, [key, value]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(acc, flattenObject(value as Record<string, unknown>, nextKey));
      return acc;
    }
    acc[nextKey] = value;
    return acc;
  }, {});
}
