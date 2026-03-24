import { Command } from 'commander';

import packageJson from '../package.json';
import { getConfigValue, listConfigEntries, setConfigValue } from './config-store';
import {
  buildCli,
  deleteActions,
  editAction,
  formatCommandTree,
  getCliManifest,
  moveAction,
} from './generated-cli';
import type { HttpMethod } from './types';
import { runInitWizard } from './init-workflow';
import { buildDoctorReport, getPrintablePaths } from './self-management';

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program
    .name('clix')
    .description('Build and publish installable CLIs from API documents.')
    .version(packageJson.version)
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command('init')
    .description('使用 TUI 初始化 clix 全局目录与大模型默认配置')
    .option('--json', '以 JSON 形式输出')
    .action(async (options) => {
      const result = await runInitWizard();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.saved ? 'Initialized clix settings.' : 'Initialization cancelled.');
      console.log(`- home: ${result.paths.homeDir}`);
      console.log(`- config: ${result.paths.configFilePath}`);
      console.log(`- llm: ${result.config.llm.provider}/${result.config.llm.model}`);
    });

  program
    .command('build [name]')
    .description('首次构建一个可全局使用的 CLI（已存在请用 update add）')
    .option('--from <source>', '文档来源，本地文件路径或 URL')
    .option('--to <directory>', '生成输出目录')
    .option('--verbose', '打开调试日志')
    .option('--yes', '跳过交互确认，使用默认建议值')
    .option('--description <desc>', 'CLI 描述')
    .option('--path <segments...>', '命令层级路径（空格分隔）')
    .option('--package <name>', 'npm 包名')
    .option('--method <method>', 'HTTP 方法（GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS）')
    .option('--host <host>', '请求 Host')
    .option('--request-path <path>', '请求 Path')
    .option('--headers <json>', '默认请求头（JSON 对象）')
    .action(async (name, options, command) => {
      const missing: string[] = [];
      if (!name) missing.push('name');
      if (!options.from) missing.push('--from');
      if (missing.length > 0) {
        console.error(`error: 缺少必填参数: ${missing.join(', ')}\n`);
        console.error('示例:');
        console.error('  clix build myapi --from ./docs/api.md');
        console.error('  clix build petstore --from https://example.com/openapi.yaml --to ./output\n');
        command.help();
        return;
      }
      const result = await buildCli({
        name,
        from: options.from,
        to: options.to,
        verbose: Boolean(options.verbose),
        yes: Boolean(options.yes),
        overrides: {
          description: options.description,
          commandPath: options.path,
          packageName: options.package,
          method: options.method,
          host: options.host,
          requestPath: options.requestPath,
          headers: options.headers ? JSON.parse(options.headers) : undefined,
        },
      });

      console.log(`\nBuilt CLI "${name}" successfully!`);
      console.log(`- target: ${result.targetDir}`);
      console.log(`- manifest: ${result.manifestFilePath}`);
      console.log(`- spec: ${result.specFilePath}`);
      if (result.shimFilePath) {
        console.log(`- command: ${result.shimFilePath}`);
      }
      console.log(`\n使用: ${name} ${result.commandPath.join(' ')} --help`);
      console.log(`增量添加: clix update ${name} add --from <另一个文档>`);
    });

  // ── update <name> [add|delete|move|edit] ───────────────────────────
  // We use allowUnknownOption + manual argv routing because commander
  // doesn't natively support `command <arg> <subcommand>` syntax well.
  program
    .command('update')
    .description('管理已有 CLI 的 action: add / delete / move / edit')
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options, command) => {
      // Raw args after "update"
      const rawArgs = command.args as string[];
      await handleUpdate(rawArgs);
    });

  program
    .command('paths')
    .description('查看 clix 运行与配置路径')
    .option('--json', '以 JSON 形式输出')
    .action(async (options) => {
      const paths = await getPrintablePaths();
      if (options.json) {
        console.log(JSON.stringify(paths, null, 2));
        return;
      }
      for (const [key, value] of Object.entries(paths)) {
        console.log(`${key}=${value}`);
      }
    });

  program
    .command('doctor')
    .description('检查 clix 全局安装、Node/npm 与运行环境')
    .option('--json', '以 JSON 形式输出')
    .action(async (options) => {
      const report = await buildDoctorReport(packageJson.version);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`clix version: ${report.version}`);
      console.log(`node: ${report.nodeVersion}`);
      console.log(`platform: ${report.platform}`);
      for (const check of report.checks) {
        console.log(`${check.ok ? 'OK' : 'WARN'} ${check.name}: ${check.detail}`);
      }
    });

  const configCommand = program.command('config').description('查看或修改 clix 全局配置');

  configCommand
    .command('list')
    .description('列出当前配置')
    .option('--json', '以 JSON 形式输出')
    .action(async (options) => {
      if (options.json) {
        console.log(JSON.stringify(await listConfigEntries(), null, 2));
        return;
      }
      const configEntries = await listConfigEntries();
      for (const [key, value] of Object.entries(configEntries)) {
        console.log(`${key}=${formatConfigValue(value)}`);
      }
    });

  configCommand
    .command('get <key>')
    .description('读取一个配置项，例如 llm.model')
    .action(async (key) => {
      const value = await getConfigValue(key);
      if (value === undefined) {
        throw new Error(`配置不存在：${key}`);
      }
      console.log(formatConfigValue(value));
    });

  configCommand
    .command('set <key> <value>')
    .description('写入一个配置项，例如 llm.model gpt-5')
    .action(async (key, value) => {
      await setConfigValue(key, value);
      console.log(`updated ${key}=${formatConfigValue(await getConfigValue(key))}`);
    });

  await program.parseAsync(argv);
}

function formatConfigValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// ── update sub-routing ──────────────────────────────────────────────

/** Minimal argv parser: extract known --flags from raw tokens. */
function extractFlags(tokens: string[], knownFlags: Record<string, 'boolean' | 'string'>): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    // Handle -h / --help
    if (t === '-h' || t === '--help') {
      flags.help = true;
      i++;
    } else if (t.startsWith('--')) {
      const flagName = t.slice(2);
      const spec = knownFlags[flagName];
      if (spec === 'boolean') {
        flags[flagName] = true;
        i++;
      } else if (spec === 'string') {
        flags[flagName] = tokens[i + 1] ?? '';
        i += 2;
      } else {
        // Unknown flag — treat as positional
        positional.push(t);
        i++;
      }
    } else {
      positional.push(t);
      i++;
    }
  }
  return { flags, positional };
}

async function handleUpdate(rawArgs: string[]): Promise<void> {
  // Strip out -h / --help from rawArgs; if present, we'll print help at the right level
  const wantsHelp = rawArgs.some((a) => a === '-h' || a === '--help');
  const args = rawArgs.filter((a) => a !== '-h' && a !== '--help');

  // ── level 0: clix update -h  (no name) ──────────────────────────
  if (args.length === 0) {
    if (wantsHelp) {
      printUpdateHelp();
    } else {
      console.error('error: 缺少 CLI 名称\n');
      console.error('用法: clix update <name> [add|delete|move|edit]');
      console.error('帮助: clix update -h');
    }
    return;
  }

  const name = args[0];
  const subcommand = args[1]; // may be undefined
  const rest = wantsHelp
    ? ['--help', ...rawArgs.slice(rawArgs.indexOf(subcommand ?? '') + 1).filter((a) => a !== '-h' && a !== '--help' && a !== name && a !== subcommand)]
    : rawArgs.slice(rawArgs.indexOf(subcommand ?? '') + 1).filter((a) => a !== name && a !== subcommand);

  // ── level 1: clix update <name> -h  (no subcommand) ─────────────
  if (!subcommand) {
    if (wantsHelp) {
      printUpdateNameHelp(name);
    } else {
      const manifest = await getCliManifest(name);
      if (!manifest) {
        console.error(`error: CLI "${name}" 尚未构建，请先使用 build:\n`);
        console.error(`  clix build ${name} --from <source>\n`);
        return;
      }
      console.log('\n当前指令树:');
      console.log(formatCommandTree(manifest));
      console.log('');
      printUpdateNameHelp(name);
    }
    return;
  }

  // ── level 2: clix update <name> <subcommand> ... ─────────────────
  // rest is already computed; if wantsHelp, '--help' is injected so
  // each handler's extractFlags will set flags.help = true.
  const restArgs = wantsHelp
    ? ['--help', ...args.slice(2)]
    : args.slice(2);

  switch (subcommand) {
    case 'add':
      return handleUpdateAdd(name, restArgs);
    case 'delete':
      return handleUpdateDelete(name, restArgs);
    case 'move':
      return handleUpdateMove(name, restArgs);
    case 'edit':
      return handleUpdateEdit(name, restArgs);
    default:
      console.error(`error: 未知子命令 "${subcommand}"\n`);
      console.error('可用子命令: add, delete, move, edit');
      return;
  }
}

function printUpdateHelp(): void {
  console.log('用法: clix update <name> [add|delete|move|edit] [options]');
  console.log('');
  console.log('管理已有 CLI 的 action。');
  console.log('');
  console.log('子命令:');
  console.log('  add     从文档导入并添加 action');
  console.log('  delete  删除一个或多个 action');
  console.log('  move    移动 action 到新路径');
  console.log('  edit    编辑 action 配置');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help  显示帮助信息');
  console.log('');
  console.log('示例:');
  console.log('  clix update myapi add --from ./docs/api.md');
  console.log('  clix update myapi delete cdb/StartCpuExpand');
  console.log('  clix update myapi -h');
  console.log('  clix update myapi delete -h');
}

function printUpdateNameHelp(name: string): void {
  console.log('可用操作:');
  console.log(`  clix update ${name} add --from <source>       添加 action（从文档导入）`);
  console.log(`  clix update ${name} delete <path>             删除 action（路径用 / 分隔）`);
  console.log(`  clix update ${name} move <path> --to <new>    移动 action 到新路径`);
  console.log(`  clix update ${name} edit <path> [options]     编辑 action 配置`);
  console.log('');
  console.log('示例:');
  console.log(`  clix update ${name} add --from ./docs/api.md`);
  console.log(`  clix update ${name} delete cdb/StartCpuExpand`);
  console.log(`  clix update ${name} move cdb/StartCpuExpand --to mysql/StartCpuExpand`);
  console.log(`  clix update ${name} edit cdb/StartCpuExpand --description "新描述" --method GET`);
}

async function handleUpdateAdd(name: string, rest: string[]): Promise<void> {
  const { flags } = extractFlags(rest, {
    from: 'string',
    to: 'string',
    verbose: 'boolean',
    yes: 'boolean',
    description: 'string',
    path: 'string',
    package: 'string',
    method: 'string',
    host: 'string',
    'request-path': 'string',
    headers: 'string',
  });

  if (flags.help) {
    console.log(`用法: clix update ${name} add --from <source> [options]`);
    console.log('');
    console.log('从文档导入并添加 action 到已有 CLI。');
    console.log('');
    console.log('Options:');
    console.log('  --from <source>         文档来源（本地文件路径或 URL）');
    console.log('  --to <directory>        生成输出目录');
    console.log('  --path <segments>       命令层级路径');
    console.log('  --description <desc>    action 描述');
    console.log('  --package <name>        npm 包名');
    console.log('  --method <method>       HTTP 方法');
    console.log('  --host <host>           请求 Host');
    console.log('  --request-path <path>   请求 Path');
    console.log('  --headers <json>        默认请求头（JSON 对象）');
    console.log('  --verbose               调试日志');
    console.log('  --yes                   跳过确认提示');
    console.log('  -h, --help              显示帮助信息');
    console.log('');
    console.log('示例:');
    console.log(`  clix update ${name} add --from ./docs/api.md`);
    console.log(`  clix update ${name} add --from https://example.com/openapi.yaml`);
    return;
  }

  if (!flags.from) {
    console.error('error: 缺少 --from 参数，请指定要添加的文档来源\n');
    console.error('示例:');
    console.error(`  clix update ${name} add --from ./docs/another-api.md`);
    console.error(`  clix update ${name} add --from https://example.com/openapi.yaml\n`);
    return;
  }

  const manifest = await getCliManifest(name);
  if (!manifest) {
    console.error(`error: CLI "${name}" 尚未构建，请先使用 build:\n`);
    console.error(`  clix build ${name} --from <source>\n`);
    return;
  }

  console.log('\n当前指令树:');
  console.log(formatCommandTree(manifest));
  console.log('');

  const pathSegments = typeof flags.path === 'string' ? flags.path.split(/[\s\/]+/).filter(Boolean) : undefined;

  const result = await buildCli({
    name,
    from: flags.from as string,
    to: flags.to as string | undefined,
    verbose: Boolean(flags.verbose),
    yes: Boolean(flags.yes),
    allowExisting: true,
    overrides: {
      description: flags.description as string | undefined,
      commandPath: pathSegments,
      packageName: flags.package as string | undefined,
      method: flags.method as HttpMethod | undefined,
      host: flags.host as string | undefined,
      requestPath: flags['request-path'] as string | undefined,
      headers: flags.headers ? JSON.parse(flags.headers as string) : undefined,
    },
  });

  const updatedManifest = await getCliManifest(name);
  if (updatedManifest) {
    console.log('\n更新后指令树:');
    console.log(formatCommandTree(updatedManifest));
  }
  console.log(`\n- spec: ${result.specFilePath}`);
  console.log(`- usage: ${name} ${result.commandPath.join(' ')} --help`);
}

async function handleUpdateDelete(name: string, rest: string[]): Promise<void> {
  const { flags, positional } = extractFlags(rest, { yes: 'boolean' });

  if (flags.help) {
    console.log(`用法: clix update ${name} delete [path ...] [options]`);
    console.log('');
    console.log('删除一个或多个 action。不指定 path 时进入交互式选择。');
    console.log('');
    console.log('Options:');
    console.log('  --yes       跳过确认提示');
    console.log('  -h, --help  显示帮助信息');
    console.log('');
    console.log('示例:');
    console.log(`  clix update ${name} delete cdb/StartCpuExpand`);
    console.log(`  clix update ${name} delete cdb/StartCpuExpand mysql/Start --yes`);
    console.log(`  clix update ${name} delete   (交互式选择)`);
    return;
  }

  const manifest = await getCliManifest(name);
  if (!manifest) {
    console.error(`error: CLI "${name}" 尚未构建。\n`);
    return;
  }

  let actionPaths = positional;

  // No path args → enter TUI multi-select
  if (actionPaths.length === 0) {
    console.log('\n当前指令树:');
    console.log(formatCommandTree(manifest));
    console.log('');

    const { ReadlineTuiAdapter } = await import('./tui');
    const adapter = new ReadlineTuiAdapter();
    try {
      const choices = manifest.actions.map((a) => ({
        value: a.commandPath.join('/'),
        label: a.commandPath.join('/'),
        hint: a.description || undefined,
      }));
      actionPaths = await adapter.multiSelect({
        message: '选择要删除的 action（Space 选择，Enter 确认）',
        choices,
        min: 1,
      });
    } catch {
      console.log('已取消。');
      return;
    } finally {
      adapter.close();
    }
  } else {
    console.log('\n当前指令树:');
    console.log(formatCommandTree(manifest));
    console.log('');
  }

  const updated = await deleteActions({
    name,
    actionPaths,
    yes: Boolean(flags.yes),
  });

  console.log('\n更新后指令树:');
  console.log(formatCommandTree(updated));
  console.log(`\n已删除 ${manifest.actions.length - updated.actions.length} 个 action。`);
}

async function handleUpdateMove(name: string, rest: string[]): Promise<void> {
  const { flags, positional } = extractFlags(rest, { to: 'string', yes: 'boolean' });

  if (flags.help) {
    console.log(`用法: clix update ${name} move <path> --to <new-path> [options]`);
    console.log('');
    console.log('移动 action 到新路径。');
    console.log('');
    console.log('Options:');
    console.log('  --to <new-path>  目标路径');
    console.log('  --yes            跳过确认提示');
    console.log('  -h, --help       显示帮助信息');
    console.log('');
    console.log('示例:');
    console.log(`  clix update ${name} move cdb/StartCpuExpand --to mysql/StartCpuExpand`);
    return;
  }

  if (positional.length === 0) {
    console.error('error: 缺少要移动的 action 路径\n');
    console.error(`用法: clix update ${name} move <path> --to <new-path>`);
    return;
  }
  if (!flags.to) {
    console.error('error: 缺少 --to 参数\n');
    console.error(`用法: clix update ${name} move ${positional[0]} --to <new-path>`);
    return;
  }

  const manifest = await getCliManifest(name);
  if (!manifest) {
    console.error(`error: CLI "${name}" 尚未构建。\n`);
    return;
  }

  console.log('\n当前指令树:');
  console.log(formatCommandTree(manifest));
  console.log('');

  const updated = await moveAction({
    name,
    actionPath: positional[0],
    newPath: flags.to as string,
    yes: Boolean(flags.yes),
  });

  console.log('\n更新后指令树:');
  console.log(formatCommandTree(updated));
}

async function handleUpdateEdit(name: string, rest: string[]): Promise<void> {
  const { flags, positional } = extractFlags(rest, {
    description: 'string',
    method: 'string',
    host: 'string',
    'request-path': 'string',
    headers: 'string',
    bin: 'string',
    yes: 'boolean',
  });

  if (flags.help) {
    console.log(`用法: clix update ${name} edit <path> [options]`);
    console.log('');
    console.log('编辑 action 配置。不指定选项时进入交互式编辑。');
    console.log('');
    console.log('Options (request 类型):');
    console.log('  --description <desc>    action 描述');
    console.log('  --method <method>       HTTP 方法');
    console.log('  --host <host>           请求 Host');
    console.log('  --request-path <path>   请求 Path');
    console.log('  --headers <json>        默认请求头（JSON 对象）');
    console.log('');
    console.log('Options (command 类型):');
    console.log('  --description <desc>    action 描述');
    console.log('  --bin <path>            可执行文件路径');
    console.log('');
    console.log('  --yes                   跳过确认提示');
    console.log('  -h, --help              显示帮助信息');
    console.log('');
    console.log('示例:');
    console.log(`  clix update ${name} edit cdb/StartCpuExpand --description "新描述"`);
    console.log(`  clix update ${name} edit codex --bin /usr/local/bin/codex`);
    return;
  }

  if (positional.length === 0) {
    return;
  }

  const manifest = await getCliManifest(name);
  if (!manifest) {
    console.error(`error: CLI "${name}" 尚未构建。\n`);
    return;
  }

  console.log('\n当前指令树:');
  console.log(formatCommandTree(manifest));
  console.log('');

  const updated = await editAction({
    name,
    actionPath: positional[0],
    description: flags.description as string | undefined,
    method: flags.method as HttpMethod | undefined,
    host: flags.host as string | undefined,
    requestPath: flags['request-path'] as string | undefined,
    headers: flags.headers ? JSON.parse(flags.headers as string) : undefined,
    bin: flags.bin as string | undefined,
    yes: Boolean(flags.yes),
  });

  console.log('\n更新后指令树:');
  console.log(formatCommandTree(updated));
}
