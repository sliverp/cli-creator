import { chmod, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { approveImport, importDocument, saveImportArtifacts } from './import-workflow';
import {
  getBuiltCliRecord,
  initClixHome,
  readClixConfig,
  type BuiltCliRecord,
  upsertBuiltCliRecord,
} from './config-store';
import { getGlobalBinDir } from './self-management';
import type { ExtractedActionDraft, HttpMethod, ParamSpec } from './types';
import type { TuiAdapter } from './tui';
import { ReadlineTuiAdapter } from './tui';
import { ensureDir, readJson, writeJson } from './utils';

const execFileAsync = promisify(execFile);
const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export interface GeneratedCliAction {
  commandPath: string[];
  description: string;
  endpoint: {
    method: HttpMethod;
    host: string;
    path: string;
    headers: Record<string, string>;
  };
  params: Array<ParamSpec & { flag: string }>;
  examples: ExtractedActionDraft['examples'];
  authHints: string[];
  meta: {
    provider: string;
    service: string;
    action: string;
    source: string;
    builtAt: string;
  };
}

export interface GeneratedCliManifest {
  cliName: string;
  packageName: string;
  description: string;
  actions: GeneratedCliAction[];
}

export interface BuildCliInput {
  name: string;
  from: string;
  to?: string;
  verbose?: boolean;
  yes?: boolean;
  installBinDir?: string;
  tui?: TuiAdapter;
  /** If true, allow building even when manifest already exists (used by update). */
  allowExisting?: boolean;
  /** CLI flag overrides — takes priority over TUI input and --yes defaults */
  overrides?: {
    description?: string;
    commandPath?: string[];
    packageName?: string;
    method?: HttpMethod;
    host?: string;
    requestPath?: string;
    headers?: Record<string, string>;
  };
}

export interface BuildCliResult {
  targetDir: string;
  packageFilePath: string;
  manifestFilePath: string;
  entryFilePath: string;
  shimFilePath?: string;
  specFilePath: string;
  commandPath: string[];
}

export interface PublishCliInput {
  name: string;
  dryRun?: boolean;
  verbose?: boolean;
  yes?: boolean;
  tag?: string;
  access?: 'public' | 'restricted';
  tui?: TuiAdapter;
}

export interface PublishCliResult {
  packageName: string;
  targetDir: string;
  dryRun: boolean;
  stdout: string;
  stderr: string;
}

interface BuildPlan {
  description: string;
  packageName: string;
  commandPath: string[];
  method: HttpMethod;
  host: string;
  path: string;
  headers: Record<string, string>;
  params: ParamSpec[];
}

export async function buildCli(input: BuildCliInput): Promise<BuildCliResult> {
  validateCliName(input.name);

  const { paths, config } = await initClixHome();
  const targetDir = path.resolve(input.to ?? path.join(paths.appsDir, input.name));
  const installBinDir = input.installBinDir ?? await getGlobalBinDir();
  const adapter = input.tui ?? new ReadlineTuiAdapter();
  const ownsAdapter = !input.tui;

  try {
    await ensureDir(targetDir);
    // If manifest already exists, this is an additive action — skip overwrite prompt
    const manifestFilePath = path.join(targetDir, 'clix.manifest.json');
    let existingManifest: GeneratedCliManifest | null = null;
    try {
      existingManifest = await readJson<GeneratedCliManifest>(manifestFilePath);
    } catch {
      // No existing manifest
    }
    if (!existingManifest) {
      await assertBuildTargetReady(targetDir, input.yes ?? false, adapter);
    } else if (!input.allowExisting) {
      throw new Error(
        `CLI "${input.name}" 已存在（${manifestFilePath}）。\n` +
        `如果要增量添加 action，请使用: clix update ${input.name} --from <source>`,
      );
    }
    debugLog(input.verbose, `build target: ${targetDir}`);

    const resolvedSource = /^https?:\/\//i.test(input.from) ? input.from : path.resolve(input.from);
    const imported = await importDocument({
      source: resolvedSource,
      provider: input.name,
      mode: config.defaults.importMode,
      outputDir: config.defaults.outputDir,
      workspaceRoot: targetDir,
    });
    debugLog(input.verbose, `draft imported: ${imported.draftFilePath}`);

    const plan = input.yes
      ? createDefaultBuildPlan(input.name, imported.draft, config, input.overrides)
      : await collectBuildPlan({
          cliName: input.name,
          draft: imported.draft,
          config,
          adapter,
          existingManifest,
          overrides: input.overrides,
        });

    const updatedDraft: ExtractedActionDraft = {
      ...imported.draft,
      description: plan.description,
      method: plan.method,
      host: plan.host,
      path: plan.path,
      params: plan.params,
      source: imported.draft.source === 'rule' ? 'merged' : imported.draft.source,
      confidence: 1,
    };

    const saved = await saveImportArtifacts({
      draft: updatedDraft,
      outputDir: config.defaults.outputDir,
      workspaceRoot: targetDir,
    });
    debugLog(input.verbose, `draft saved: ${saved.draftFilePath}`);

    const approved = await approveImport({
      provider: updatedDraft.provider,
      service: updatedDraft.service,
      action: updatedDraft.action,
      outputDir: config.defaults.outputDir,
      workspaceRoot: targetDir,
      force: true,
    });

    const action = createAction({
      commandPath: plan.commandPath,
      headers: plan.headers,
      draft: updatedDraft,
    });

    const manifest = mergeActionIntoManifest(
      existingManifest,
      input.name,
      plan.packageName,
      plan.description,
      action,
    );

    const generated = await writeGeneratedPackage({
      targetDir,
      cliName: input.name,
      packageName: plan.packageName,
      manifest,
    });

    let shimFilePath: string | undefined;
    if (installBinDir) {
      shimFilePath = await installCommandShim({
        cliName: input.name,
        entryFilePath: generated.entryFilePath,
        installBinDir,
      });
    }

    const builtAt = new Date().toISOString();
    const record: BuiltCliRecord = {
      name: input.name,
      packageName: plan.packageName,
      targetDir,
      manifestFilePath: generated.manifestFilePath,
      entryFilePath: generated.entryFilePath,
      shimFilePath,
      commandPath: plan.commandPath,
      source: resolvedSource,
      builtAt,
    };
    await upsertBuiltCliRecord(record);

    return {
      targetDir,
      packageFilePath: generated.packageFilePath,
      manifestFilePath: generated.manifestFilePath,
      entryFilePath: generated.entryFilePath,
      shimFilePath,
      specFilePath: approved.specFilePath,
      commandPath: plan.commandPath,
    };
  } finally {
    if (ownsAdapter) {
      await adapter.close?.();
    }
  }
}

export async function getCliManifest(name: string): Promise<GeneratedCliManifest | null> {
  const record = await getBuiltCliRecord(name);
  if (!record) {
    return null;
  }
  try {
    return await readJson<GeneratedCliManifest>(record.manifestFilePath);
  } catch {
    return null;
  }
}

// ── Delete actions ────────────────────────────────────────────────────

export interface DeleteActionsInput {
  name: string;
  /** Action paths to delete, each as slash-separated string e.g. "cdb/StartCpuExpand" */
  actionPaths: string[];
  yes?: boolean;
  tui?: TuiAdapter;
}

export async function deleteActions(input: DeleteActionsInput): Promise<GeneratedCliManifest> {
  const record = await getBuiltCliRecord(input.name);
  if (!record) {
    throw new Error(`CLI "${input.name}" 尚未构建。`);
  }
  const manifest = await readJson<GeneratedCliManifest>(record.manifestFilePath);

  const pathsToDelete = input.actionPaths.map((p) => p.replace(/\//g, ' '));
  const toDelete = manifest.actions.filter((a) =>
    pathsToDelete.includes(a.commandPath.join(' ')),
  );

  if (toDelete.length === 0) {
    const available = manifest.actions.map((a) => a.commandPath.join('/')).join(', ');
    throw new Error(`未找到匹配的 action。可用: ${available}`);
  }

  if (!input.yes) {
    const adapter = input.tui ?? new ReadlineTuiAdapter();
    try {
      console.log('将删除以下 action:');
      for (const a of toDelete) {
        console.log(`  - ${a.commandPath.join('/')} — ${a.description || ''}`);
      }
      const confirmed = await adapter.confirm({
        message: `确认删除 ${toDelete.length} 个 action？`,
        defaultValue: false,
      });
      if (!confirmed) {
        throw new Error('用户取消删除。');
      }
    } finally {
      if (!input.tui) {
        adapter.close?.();
      }
    }
  }

  const remaining = manifest.actions.filter((a) =>
    !pathsToDelete.includes(a.commandPath.join(' ')),
  );

  if (remaining.length === 0) {
    throw new Error('不能删除所有 action，至少需要保留一个。');
  }

  const updated: GeneratedCliManifest = { ...manifest, actions: remaining };
  await regenerateCli(input.name, updated);
  return updated;
}

// ── Move action ───────────────────────────────────────────────────────

export interface MoveActionInput {
  name: string;
  /** Source action path, slash-separated e.g. "cdb/StartCpuExpand" */
  actionPath: string;
  /** New path, slash-separated e.g. "mysql/StartCpuExpand" */
  newPath: string;
  yes?: boolean;
  tui?: TuiAdapter;
}

export async function moveAction(input: MoveActionInput): Promise<GeneratedCliManifest> {
  const record = await getBuiltCliRecord(input.name);
  if (!record) {
    throw new Error(`CLI "${input.name}" 尚未构建。`);
  }
  const manifest = await readJson<GeneratedCliManifest>(record.manifestFilePath);

  const sourcePath = input.actionPath.replace(/\//g, ' ');
  const action = manifest.actions.find((a) => a.commandPath.join(' ') === sourcePath);
  if (!action) {
    const available = manifest.actions.map((a) => a.commandPath.join('/')).join(', ');
    throw new Error(`未找到 action: ${input.actionPath}。可用: ${available}`);
  }

  const newCommandPath = input.newPath.split('/').map((s) => s.trim()).filter(Boolean);
  if (newCommandPath.length === 0) {
    throw new Error('新路径不能为空。');
  }

  const newPathStr = newCommandPath.join(' ');
  const conflict = manifest.actions.find((a) =>
    a.commandPath.join(' ') === newPathStr && a !== action,
  );
  if (conflict) {
    throw new Error(`目标路径 ${input.newPath} 已被占用。`);
  }

  if (!input.yes) {
    const adapter = input.tui ?? new ReadlineTuiAdapter();
    try {
      const confirmed = await adapter.confirm({
        message: `将 ${input.actionPath} 移动到 ${input.newPath}？`,
        defaultValue: true,
      });
      if (!confirmed) {
        throw new Error('用户取消移动。');
      }
    } finally {
      if (!input.tui) {
        adapter.close?.();
      }
    }
  }

  action.commandPath = newCommandPath;

  const updated: GeneratedCliManifest = { ...manifest };
  await regenerateCli(input.name, updated);
  return updated;
}

// ── Edit action ───────────────────────────────────────────────────────

export interface EditActionInput {
  name: string;
  /** Action path, slash-separated */
  actionPath: string;
  /** Partial overrides */
  description?: string;
  method?: HttpMethod;
  host?: string;
  requestPath?: string;
  headers?: Record<string, string>;
  yes?: boolean;
  tui?: TuiAdapter;
}

export async function editAction(input: EditActionInput): Promise<GeneratedCliManifest> {
  const record = await getBuiltCliRecord(input.name);
  if (!record) {
    throw new Error(`CLI "${input.name}" 尚未构建。`);
  }
  const manifest = await readJson<GeneratedCliManifest>(record.manifestFilePath);

  const sourcePath = input.actionPath.replace(/\//g, ' ');
  const action = manifest.actions.find((a) => a.commandPath.join(' ') === sourcePath);
  if (!action) {
    const available = manifest.actions.map((a) => a.commandPath.join('/')).join(', ');
    throw new Error(`未找到 action: ${input.actionPath}。可用: ${available}`);
  }

  // Apply overrides from CLI flags
  if (input.description !== undefined) action.description = input.description;
  if (input.method !== undefined) action.endpoint.method = input.method;
  if (input.host !== undefined) action.endpoint.host = input.host;
  if (input.requestPath !== undefined) action.endpoint.path = input.requestPath;
  if (input.headers !== undefined) action.endpoint.headers = { ...action.endpoint.headers, ...input.headers };

  // If no flags provided, enter TUI mode
  const hasFlags = input.description !== undefined || input.method !== undefined
    || input.host !== undefined || input.requestPath !== undefined || input.headers !== undefined;

  if (!hasFlags && !input.yes) {
    const adapter = input.tui ?? new ReadlineTuiAdapter();
    try {
      action.description = await adapter.input({
        message: '描述',
        defaultValue: action.description,
      });
      action.endpoint.method = await adapter.select<HttpMethod>({
        message: 'HTTP Method',
        defaultValue: action.endpoint.method,
        choices: (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as HttpMethod[]).map((m) => ({ value: m, label: m })),
      });
      action.endpoint.host = await adapter.input({
        message: '请求 Host',
        defaultValue: action.endpoint.host,
        validate: (v) => (v.trim() ? undefined : 'Host 不能为空。'),
      });
      action.endpoint.path = await adapter.input({
        message: '请求 Path',
        defaultValue: action.endpoint.path,
        validate: (v) => (v.trim() ? undefined : 'Path 不能为空。'),
      });
      const headersText = await adapter.input({
        message: '默认请求头（JSON 对象）',
        defaultValue: JSON.stringify(action.endpoint.headers),
        validate: (v) => {
          try { JSON.parse(v); return undefined; } catch (e) { return String(e); }
        },
      });
      action.endpoint.headers = JSON.parse(headersText);
    } finally {
      if (!input.tui) {
        adapter.close?.();
      }
    }
  }

  const updated: GeneratedCliManifest = { ...manifest };
  await regenerateCli(input.name, updated);
  return updated;
}

// ── Regenerate CLI entry + manifest ───────────────────────────────────

export async function regenerateCli(name: string, manifest: GeneratedCliManifest): Promise<void> {
  const record = await getBuiltCliRecord(name);
  if (!record) {
    throw new Error(`CLI "${name}" 尚未构建。`);
  }
  const targetDir = record.targetDir;
  await writeGeneratedPackage({
    targetDir,
    cliName: name,
    packageName: manifest.packageName,
    manifest,
  });
}

export function formatCommandTree(manifest: GeneratedCliManifest): string {
  interface TreeNode { children: Record<string, TreeNode>; action?: GeneratedCliAction }
  const root: TreeNode = { children: {} };
  for (const action of manifest.actions) {
    let node = root;
    for (const seg of action.commandPath) {
      if (!node.children[seg]) {
        node.children[seg] = { children: {} };
      }
      node = node.children[seg];
    }
    node.action = action;
  }

  const lines: string[] = [];
  lines.push(`${manifest.cliName} (${manifest.actions.length} action${manifest.actions.length > 1 ? 's' : ''})`);

  function walk(node: TreeNode, prefix: string, isRoot: boolean) {
    const keys = Object.keys(node.children);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const child = node.children[key];
      const last = i === keys.length - 1;
      const connector = last ? '└── ' : '├── ';
      const childPrefix = last ? '    ' : '│   ';
      const desc = child.action ? ` — ${child.action.description || ''}` : '';
      const leafMarker = child.action ? ' ●' : '';
      lines.push(`${prefix}${connector}${key}${leafMarker}${desc}`);
      walk(child, prefix + childPrefix, false);
    }
  }
  walk(root, '', true);
  return lines.join('\n');
}

function manifestToTreePickerNode(manifest: GeneratedCliManifest): import('./tui').TreePickerNode {
  interface InternalNode {
    children: Record<string, InternalNode>;
    isAction?: boolean;
    hint?: string;
    path: string[];
  }
  const root: InternalNode = { children: {}, path: [] };
  for (const action of manifest.actions) {
    let node = root;
    for (let i = 0; i < action.commandPath.length; i++) {
      const seg = action.commandPath[i];
      if (!node.children[seg]) {
        node.children[seg] = { children: {}, path: action.commandPath.slice(0, i + 1) };
      }
      node = node.children[seg];
    }
    node.isAction = true;
    node.hint = action.description;
  }

  function convert(node: InternalNode, label: string): import('./tui').TreePickerNode {
    return {
      label,
      path: node.path,
      isAction: node.isAction,
      hint: node.hint,
      children: Object.entries(node.children).map(([key, child]) => convert(child, key)),
    };
  }

  return convert(root, manifest.cliName);
}

export async function publishCli(input: PublishCliInput): Promise<PublishCliResult> {
  const { config } = await initClixHome();
  const record = await getBuiltCliRecord(input.name);
  if (!record) {
    throw new Error(`未找到已构建 CLI：${input.name}`);
  }

  const adapter = input.tui ?? new ReadlineTuiAdapter();
  const ownsAdapter = !input.tui;

  try {
    const packageJson = await readJson<{ name: string }>(path.join(record.targetDir, 'package.json'));
    const tag = input.tag ?? config.defaults.publishTag;
    const access = input.access ?? config.defaults.npmAccess;

    if (!(input.yes ?? false)) {
      const confirmed = await adapter.confirm({
        message: `确认发布 ${packageJson.name} 吗？tag=${tag} access=${access}${input.dryRun ? ' (dry-run)' : ''}`,
        defaultValue: true,
      });
      if (!confirmed) {
        throw new Error('用户取消发布。');
      }
    }

    const args = ['publish', '--tag', tag, '--access', access];
    if (input.dryRun) {
      args.push('--dry-run');
    }

    debugLog(input.verbose, `npm ${args.join(' ')}`);
    const { stdout, stderr } = await execFileAsync('npm', args, {
      cwd: record.targetDir,
      maxBuffer: 1024 * 1024,
    });

    if (!input.dryRun) {
      await upsertBuiltCliRecord({
        ...record,
        publishedAt: new Date().toISOString(),
      });
    }

    return {
      packageName: packageJson.name,
      targetDir: record.targetDir,
      dryRun: Boolean(input.dryRun),
      stdout,
      stderr,
    };
  } finally {
    if (ownsAdapter) {
      await adapter.close?.();
    }
  }
}

async function assertBuildTargetReady(targetDir: string, yes: boolean, adapter: TuiAdapter): Promise<void> {
  const entries = await readdir(targetDir).catch(() => [] as string[]);
  if (entries.length === 0 || yes) {
    return;
  }

  const confirmed = await adapter.confirm({
    message: `目标目录 ${targetDir} 已存在内容，是否继续覆盖生成？`,
    defaultValue: false,
  });
  if (!confirmed) {
    throw new Error('用户取消构建。');
  }
}

function createDefaultBuildPlan(
  name: string,
  draft: ExtractedActionDraft,
  config: Awaited<ReturnType<typeof readClixConfig>>,
  overrides?: BuildCliInput['overrides'],
): BuildPlan {
  return {
    description: overrides?.description ?? (draft.description?.trim() || `${name} generated CLI`),
    packageName: overrides?.packageName ?? defaultPackageName(name, config.defaults.packageScope),
    commandPath: overrides?.commandPath ?? [draft.service, draft.action],
    method: overrides?.method ?? draft.method ?? 'POST',
    host: overrides?.host ?? draft.host ?? 'example.com',
    path: overrides?.requestPath ?? draft.path ?? '/',
    headers: overrides?.headers ?? inferDefaultHeaders(draft),
    params: draft.params,
  };
}

async function collectBuildPlan(args: {
  cliName: string;
  draft: ExtractedActionDraft;
  config: Awaited<ReturnType<typeof readClixConfig>>;
  adapter: TuiAdapter;
  existingManifest?: GeneratedCliManifest | null;
  overrides?: BuildCliInput['overrides'];
}): Promise<BuildPlan> {
  const { cliName, draft, config, adapter, existingManifest, overrides } = args;

  const description = overrides?.description ?? await adapter.input({
    message: '确认 CLI 描述',
    defaultValue: draft.description?.trim() || `${cliName} generated CLI`,
    validate: (value) => (value.trim() ? undefined : '描述不能为空。'),
  });

  let commandPath: string[];

  if (overrides?.commandPath) {
    commandPath = overrides.commandPath;
  } else if (existingManifest && existingManifest.actions.length > 0) {
    // Use interactive tree picker when updating an existing CLI
    const { pickTreeInsertionPoint } = await import('./tui');
    const treeRoot = manifestToTreePickerNode(existingManifest);
    const newActionName = draft.action || 'NewAction';

    // Destroy the adapter's readline interface before entering raw-mode
    // tree picker so they don't compete for stdin.
    adapter.close?.();

    const parentPath = await pickTreeInsertionPoint({
      message: '选择新 action 的插入位置',
      root: treeRoot,
      newActionName,
    });
    commandPath = [...parentPath, newActionName];
  } else {
    // First build: use text input
    const hierarchyText = await adapter.input({
      message: '确认功能层级（使用空格分隔命令层级）',
      defaultValue: `${draft.service} ${draft.action}`,
      validate: (value) => validateCommandPath(value),
    });
    commandPath = hierarchyText.trim().split(/\s+/);
  }

  const packageName = overrides?.packageName ?? await adapter.input({
    message: '确认 npm 包名',
    defaultValue: defaultPackageName(cliName, config.defaults.packageScope),
    validate: (value) => validatePackageName(value),
  });

  const method = overrides?.method ?? await adapter.select<HttpMethod>({
    message: '请选择 HTTP Method',
    defaultValue: draft.method ?? 'POST',
    choices: HTTP_METHODS.map((item) => ({ value: item, label: item })),
  });

  const host = overrides?.host ?? await adapter.input({
    message: '确认请求 Host',
    defaultValue: draft.host ?? '',
    validate: (value) => (value.trim() ? undefined : 'Host 不能为空。'),
  });

  const requestPath = overrides?.requestPath ?? await adapter.input({
    message: '确认请求 Path',
    defaultValue: draft.path ?? '/',
    validate: (value) => (value.trim() ? undefined : 'Path 不能为空。'),
  });

  let headers: Record<string, string>;
  if (overrides?.headers) {
    headers = overrides.headers;
  } else {
    const headersText = await adapter.input({
      message: '确认默认请求头（JSON 对象）',
      defaultValue: JSON.stringify(inferDefaultHeaders(draft)),
      validate: (value) => validateHeaderJson(value),
    });
    headers = parseHeaderJson(headersText);
  }

  const params = await reviewParams(draft.params, adapter);
  const summary = [
    `层级: ${commandPath.join(' ')}`,
    `方法: ${method}`,
    `地址: ${host}${requestPath}`,
    `参数数: ${params.length}`,
    `包名: ${packageName.trim()}`,
  ].join('\n');
  console.log(summary);

  const confirmed = await adapter.confirm({
    message: '确认按以上配置生成 CLI？',
    defaultValue: true,
  });
  if (!confirmed) {
    throw new Error('用户取消构建。');
  }

  return {
    description: description.trim(),
    packageName: packageName.trim(),
    commandPath,
    method,
    host: host.trim(),
    path: requestPath.trim(),
    headers,
    params,
  };
}

async function reviewParams(params: ParamSpec[], adapter: TuiAdapter): Promise<ParamSpec[]> {
  if (params.length === 0) return [];

  const { editParamsTable } = await import('./tui');

  // Destroy the adapter's readline interface before entering raw-mode
  // table editor so they don't compete for stdin.
  adapter.close?.();

  const result = await editParamsTable(
    params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      location: p.location,
      description: p.description,
    })),
  );

  return result.map((r) => {
    const original = params.find((p) => p.name === r.name);
    return {
      ...(original ?? { name: r.name, enum: undefined }),
      type: r.type as ParamSpec['type'],
      required: r.required,
      location: r.location,
      description: r.description,
    };
  });
}

function createAction(args: {
  commandPath: string[];
  headers: Record<string, string>;
  draft: ExtractedActionDraft;
}): GeneratedCliAction {
  const builtAt = new Date().toISOString();
  return {
    commandPath: args.commandPath,
    description: args.draft.description?.trim() || args.commandPath.join(' '),
    endpoint: {
      method: args.draft.method ?? 'POST',
      host: args.draft.host ?? 'example.com',
      path: args.draft.path ?? '/',
      headers: args.headers,
    },
    params: args.draft.params.map((param) => ({
      ...param,
      flag: `--${param.name}`,
    })),
    examples: args.draft.examples,
    authHints: args.draft.authHints,
    meta: {
      provider: args.draft.provider,
      service: args.draft.service,
      action: args.draft.action,
      source: args.draft.input.sourceLabel,
      builtAt,
    },
  };
}

function mergeActionIntoManifest(
  existing: GeneratedCliManifest | null,
  cliName: string,
  packageName: string,
  description: string,
  action: GeneratedCliAction,
): GeneratedCliManifest {
  if (!existing) {
    return {
      cliName,
      packageName,
      description,
      actions: [action],
    };
  }

  // Replace existing action with same commandPath, or append
  const actionKey = action.commandPath.join(' ');
  const actions = existing.actions.filter(
    (a) => a.commandPath.join(' ') !== actionKey,
  );
  actions.push(action);

  return {
    ...existing,
    actions,
  };
}

async function writeGeneratedPackage(args: {
  targetDir: string;
  cliName: string;
  packageName: string;
  manifest: GeneratedCliManifest;
}): Promise<{ packageFilePath: string; manifestFilePath: string; entryFilePath: string }> {
  const packageFilePath = path.join(args.targetDir, 'package.json');
  const manifestFilePath = path.join(args.targetDir, 'clix.manifest.json');
  const entryFilePath = path.join(args.targetDir, 'bin', `${args.cliName}.js`);

  await ensureDir(path.dirname(entryFilePath));
  await writeJson(manifestFilePath, args.manifest);
  await writeFile(
    packageFilePath,
    `${JSON.stringify(
      {
        name: args.packageName,
        version: '0.1.0',
        description: args.manifest.description,
        license: 'MIT',
        files: ['bin', 'clix.manifest.json'],
        bin: {
          [args.cliName]: `bin/${args.cliName}.js`,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(entryFilePath, renderGeneratedCliEntry(), 'utf8');
  await chmod(entryFilePath, 0o755);

  return { packageFilePath, manifestFilePath, entryFilePath };
}

async function installCommandShim(args: {
  cliName: string;
  entryFilePath: string;
  installBinDir: string;
}): Promise<string> {
  await ensureDir(args.installBinDir);

  if (process.platform === 'win32') {
    const shimFilePath = path.join(args.installBinDir, `${args.cliName}.cmd`);
    await writeFile(shimFilePath, `@echo off\r\nnode "${args.entryFilePath}" %*\r\n`, 'utf8');
    return shimFilePath;
  }

  const shimFilePath = path.join(args.installBinDir, args.cliName);
  await writeFile(shimFilePath, `#!/usr/bin/env sh\nnode "${args.entryFilePath}" "$@"\n`, 'utf8');
  await chmod(shimFilePath, 0o755);
  return shimFilePath;
}

function validateCliName(value: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error('CLI 名称必须是小写字母开头，只能包含小写字母、数字和中划线。');
  }
}

function validateCommandPath(value: string): string | undefined {
  const segments = value.trim().split(/\s+/).filter(Boolean);
  if (segments.length === 0) {
    return '至少需要一个命令层级。';
  }
  if (segments.some((segment) => segment.startsWith('-'))) {
    return '命令层级不能以 - 开头。';
  }
  return undefined;
}

function validatePackageName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return '包名不能为空。';
  }
  if (!/^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/i.test(trimmed)) {
    return '包名不合法。';
  }
  return undefined;
}

function validateHeaderJson(value: string): string | undefined {
  try {
    const parsed = parseHeaderJson(value);
    if (Object.values(parsed).some((item) => typeof item !== 'string')) {
      return '请求头的值必须是字符串。';
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseHeaderJson(value: string): Record<string, string> {
  const trimmed = value.trim() || '{}';
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求头必须是 JSON 对象。');
  }
  return Object.entries(parsed).reduce<Record<string, string>>((acc, [key, item]) => {
    acc[key] = String(item);
    return acc;
  }, {});
}

function defaultPackageName(cliName: string, packageScope?: string): string {
  return packageScope ? `${packageScope}/${cliName}` : cliName;
}

function inferDefaultHeaders(draft: ExtractedActionDraft): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const actionEvidence = draft.evidence.find((item) => item.kind === 'action')?.snippet;
  const actionHeaderMatch = actionEvidence?.match(/^(X-[A-Za-z-]*Action):\s*(.+)$/im);
  if (actionHeaderMatch) {
    headers[actionHeaderMatch[1]] = actionHeaderMatch[2].trim();
  }

  return headers;
}

function debugLog(verbose: boolean | undefined, message: string): void {
  if (verbose) {
    console.log(`[clix:debug] ${message}`);
  }
}

function renderGeneratedCliEntry(): string {
  return [
    '#!/usr/bin/env node',
    "const { readFileSync } = require('node:fs');",
    "const path = require('node:path');",
    '',
    "const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'clix.manifest.json'), 'utf8'));",
    '',
    '// Build a tree from all actions for hierarchical help',
    'function buildCommandTree() {',
    '  const tree = { children: {}, actions: [] };',
    '  for (const action of manifest.actions) {',
    '    let node = tree;',
    '    for (const seg of action.commandPath) {',
    '      if (!node.children[seg]) {',
    '        node.children[seg] = { children: {}, actions: [] };',
    '      }',
    '      node = node.children[seg];',
    '    }',
    '    node.actions.push(action);',
    '  }',
    '  return tree;',
    '}',
    '',
    'function printLevelHelp(prefix, node, errorMessage) {',
    '  if (errorMessage) {',
    '    console.error(errorMessage);',
    "    console.error('');",
    '  }',
    "  console.log(prefix.length > 0 ? prefix.join(' ') + ' - available subcommands:' : (manifest.description || manifest.cliName + ' CLI'));",
    "  console.log('');",
    '  // Flatten a chain of single-child nodes into one label, e.g. "Ecs / RunInstances"',
    '  function collectEntries(nd) {',
    '    var entries = [];',
    '    var subs = Object.keys(nd.children);',
    '    for (var s = 0; s < subs.length; s++) {',
    '      var sub = subs[s];',
    '      var child = nd.children[sub];',
    '      // Collapse single-child intermediate nodes',
    '      var label = sub;',
    '      var cur = child;',
    '      while (Object.keys(cur.children).length === 1 && cur.actions.length === 0) {',
    '        var onlyKey = Object.keys(cur.children)[0];',
    "        label += ' / ' + onlyKey;",
    '        cur = cur.children[onlyKey];',
    '      }',
    '      // cur is either a branching node or a leaf',
    '      var leafActions = getAllLeafActions(cur);',
    '      if (cur.actions.length === 1 && Object.keys(cur.children).length === 0) {',
    '        // Terminal action — show description and required params inline',
    '        var action = cur.actions[0];',
    "        var desc = action.description ? ' — ' + action.description : '';",
    '        var params = action.params || [];',
    "        var reqParams = params.filter(function(p) { return p.required; });",
    "        var paramHint = reqParams.length > 0 ? ' [' + reqParams.map(function(p) { return p.flag; }).join(', ') + ']' : '';",
    "        entries.push({ label: label + desc + paramHint, children: null });",
    '      } else {',
    "        var countStr = leafActions.length > 0 ? ' (' + leafActions.length + ' action' + (leafActions.length > 1 ? 's' : '') + ')' : '';",
    '        entries.push({ label: label + countStr, children: cur });',
    '      }',
    '    }',
    '    // Actions directly on this node (rare but possible)',
    '    for (var a = 0; a < nd.actions.length; a++) {',
    '      var action = nd.actions[a];',
    "      var desc = action.description ? ' — ' + action.description : '';",
    '      var params = action.params || [];',
    "      var reqParams = params.filter(function(p) { return p.required; });",
    "      var paramHint = reqParams.length > 0 ? ' [' + reqParams.map(function(p) { return p.flag; }).join(', ') + ']' : '';",
    '      entries.push({ label: action.commandPath[action.commandPath.length - 1] + desc + paramHint, children: null });',
    '    }',
    '    return entries;',
    '  }',
    '  function printTree(nd, indent) {',
    '    var entries = collectEntries(nd);',
    '    for (var i = 0; i < entries.length; i++) {',
    '      var isLast = i === entries.length - 1;',
    "      var connector = isLast ? '└── ' : '├── ';",
    "      var childIndent = indent + (isLast ? '    ' : '│   ');",
    '      console.log(indent + connector + entries[i].label);',
    '      if (entries[i].children) {',
    '        printTree(entries[i].children, childIndent);',
    '      }',
    '    }',
    '  }',
    "  printTree(node, '  ');",
    "  console.log('');",
    "  console.log('Run ' + [manifest.cliName].concat(prefix).concat(['<subcommand>', '--help']).join(' ') + ' for more info.');",
    '}',
    '',
    'function getAllLeafActions(node) {',
    '  let result = [].concat(node.actions);',
    '  for (const key of Object.keys(node.children)) {',
    '    result = result.concat(getAllLeafActions(node.children[key]));',
    '  }',
    '  return result;',
    '}',
    '',
    'function printActionHelp(action, errorMessage) {',
    '  if (errorMessage) {',
    '    console.error(errorMessage);',
    "    console.error('');",
    '  }',
    '  console.log(action.description);',
    "  console.log('');",
    "  console.log('Usage:');",
    "  console.log('  ' + manifest.cliName + ' ' + action.commandPath.join(' ') + ' [options]');",
    "  console.log('');",
    "  console.log('Options:');",
    "  console.log('  -h, --help       Show help');",
    "  console.log('  --dry-run        Print request payload without sending');",
    "  console.log('  --verbose        Print request details');",
    "  console.log('  --header K=V     Append custom header');",
    '  for (const param of action.params) {',
    "    console.log('  ' + param.flag + (param.required ? ' (required)' : '') + '  ' + (param.description || param.type));",
    '  }',
    '}',
    '',
    'function matchAction(argv) {',
    '  // Sort actions by commandPath length descending for longest match first',
    '  const sorted = manifest.actions.slice().sort((a, b) => b.commandPath.length - a.commandPath.length);',
    '  for (const action of sorted) {',
    '    const cp = action.commandPath;',
    '    if (argv.length >= cp.length && cp.every((seg, i) => seg === argv[i])) {',
    '      return { action, rest: argv.slice(cp.length) };',
    '    }',
    '  }',
    '  return null;',
    '}',
    '',
    'function coerceValue(type, value) {',
    "  if (type === 'number') {",
    '    return Number(value);',
    '  }',
    "  if (type === 'boolean') {",
    "    if (value === true || value === 'true') return true;",
    "    if (value === false || value === 'false') return false;",
    '  }',
    "  if (type === 'array' || type === 'object') {",
    '    try {',
    '      return JSON.parse(String(value));',
    '    } catch {',
    '      return value;',
    '    }',
    '  }',
    '  return value;',
    '}',
    '',
    'function parseArgs(action, argv) {',
    '  const state = { params: {}, headers: {}, dryRun: false, verbose: false, help: false };',
    '  for (let index = 0; index < argv.length; index += 1) {',
    '    const token = argv[index];',
    "    if (token === '-h' || token === '--help') {",
    '      state.help = true;',
    '      continue;',
    '    }',
    "    if (token === '--dry-run') {",
    '      state.dryRun = true;',
    '      continue;',
    '    }',
    "    if (token === '--verbose') {",
    '      state.verbose = true;',
    '      continue;',
    '    }',
    "    if (token === '--header') {",
    '      const next = argv[index + 1];',
    "      if (!next || next.startsWith('--')) {",
    "        throw new Error('--header 需要 K=V 值');",
    '      }',
    "      const headerIndex = next.indexOf('=');",
    '      if (headerIndex < 1) {',
    "        throw new Error('--header 需要 K=V 值');",
    '      }',
    '      state.headers[next.slice(0, headerIndex)] = next.slice(headerIndex + 1);',
    '      index += 1;',
    '      continue;',
    '    }',
    "    if (!token.startsWith('--')) {",
    "      throw new Error('未识别的参数：' + token);",
    '    }',
    '    const optionName = token;',
    '    const param = action.params.find((item) => item.flag === optionName);',
    '    if (!param) {',
    "      throw new Error('未识别的参数：' + optionName);",
    '    }',
    '    const next = argv[index + 1];',
    "    if (!next || next.startsWith('--')) {",
    "      if (param.type === 'boolean') {",
    '        state.params[param.name] = true;',
    '        continue;',
    '      }',
    "      throw new Error(optionName + ' 需要一个值');",
    '    }',
    '    state.params[param.name] = coerceValue(param.type, next);',
    '    index += 1;',
    '  }',
    '  return state;',
    '}',
    '',
    'function buildRequest(action, parsed) {',
    '  const headers = { ...action.endpoint.headers, ...parsed.headers };',
    '  const pathParams = {};',
    '  const queryParams = new URLSearchParams();',
    '  const body = {};',
    '',
    '  for (const param of action.params) {',
    '    const value = parsed.params[param.name];',
    '    if (value === undefined) {',
    '      continue;',
    '    }',
    "    if (param.location === 'header') {",
    '      headers[param.name] = String(value);',
    '      continue;',
    '    }',
    "    if (param.location === 'path') {",
    '      pathParams[param.name] = String(value);',
    '      continue;',
    '    }',
    "    if (param.location === 'query') {",
    "      queryParams.set(param.name, typeof value === 'string' ? value : JSON.stringify(value));",
    '      continue;',
    '    }',
    '    body[param.name] = value;',
    '  }',
    '',
    '  let resolvedPath = action.endpoint.path;',
    '  for (const [key, value] of Object.entries(pathParams)) {',
    "    resolvedPath = resolvedPath.replace(new RegExp('\\\\{' + key + '\\\\}', 'g'), value).replace(new RegExp(':' + key + '(?=/|$)', 'g'), value);",
    '  }',
    '',
    "  const host = /^https?:\\/\\//i.test(action.endpoint.host)",
    '    ? action.endpoint.host',
    "    : 'https://' + action.endpoint.host;",
    '  const url = new URL(resolvedPath, host);',
    '  for (const [key, value] of queryParams.entries()) {',
    '    url.searchParams.set(key, value);',
    '  }',
    '',
    "  const hasBody = Object.keys(body).length > 0 && !['GET', 'HEAD'].includes(action.endpoint.method);",
    "  if (hasBody && !headers['Content-Type']) {",
    "    headers['Content-Type'] = 'application/json';",
    '  }',
    '',
    '  return {',
    '    method: action.endpoint.method,',
    '    url: url.toString(),',
    '    headers,',
    '    body,',
    '    hasBody,',
    '  };',
    '}',
    '',
    'async function main(argv = process.argv.slice(2)) {',
    '  const tree = buildCommandTree();',
    '',
    '  // Strip trailing -h / --help to detect help at any level',
    "  const isHelp = argv.length === 0 || argv[argv.length - 1] === '-h' || argv[argv.length - 1] === '--help';",
    "  const nonHelpArgv = argv.filter((a) => a !== '-h' && a !== '--help');",
    '',
    '  // Walk tree level-by-level to find where we are',
    '  if (isHelp && !matchAction(nonHelpArgv)) {',
    '    // Not a full action match — show hierarchical help',
    '    let node = tree;',
    '    const consumed = [];',
    '    for (const seg of nonHelpArgv) {',
    '      if (node.children[seg]) {',
    '        consumed.push(seg);',
    '        node = node.children[seg];',
    '      } else {',
    '        break;',
    '      }',
    '    }',
    '    printLevelHelp(consumed, node);',
    '    return;',
    '  }',
    '',
    '  const matched = matchAction(argv.filter((a) => a !== \'-h\' && a !== \'--help\'));',
    '  if (!matched) {',
    '    // Walk tree to find the deepest matching level for helpful error',
    '    let node = tree;',
    '    const consumed = [];',
    '    for (const seg of nonHelpArgv) {',
    '      if (node.children[seg]) {',
    '        consumed.push(seg);',
    '        node = node.children[seg];',
    '      } else {',
    '        break;',
    '      }',
    '    }',
    "    printLevelHelp(consumed, node, '未匹配到完整的 action，请补全子命令。');",
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '',
    '  const { action, rest } = matched;',
    "  const parsed = parseArgs(action, rest.filter((a) => a !== '-h' && a !== '--help'));",
    '',
    '  // If original argv had help flags but we matched an action, show action help',
    '  if (isHelp) {',
    '    printActionHelp(action);',
    '    return;',
    '  }',
    '',
    '  const missing = action.params.filter((param) => param.required && parsed.params[param.name] === undefined);',
    '  if (missing.length > 0) {',
    "    throw new Error('缺少必填参数：' + missing.map((item) => item.name).join(', '));",
    '  }',
    '',
    '  const request = buildRequest(action, parsed);',
    '  if (parsed.verbose || parsed.dryRun) {',
    '    console.log(JSON.stringify(request, null, 2));',
    '  }',
    '  if (parsed.dryRun) {',
    '    return;',
    '  }',
    '',
    '  const response = await fetch(request.url, {',
    '    method: request.method,',
    '    headers: request.headers,',
    '    body: request.hasBody ? JSON.stringify(request.body) : undefined,',
    '  });',
    '  const text = await response.text();',
    '  try {',
    '    console.log(JSON.stringify(JSON.parse(text), null, 2));',
    '  } catch {',
    '    console.log(text);',
    '  }',
    '  if (!response.ok) {',
    '    process.exitCode = 1;',
    '  }',
    '}',
    '',
    'main().catch((error) => {',
    "  console.error(error instanceof Error ? error.message : String(error));",
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}
