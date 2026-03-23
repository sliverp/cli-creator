import { Command } from 'commander';

import packageJson from '../package.json';
import { getConfigValue, listConfigEntries, setConfigValue } from './config-store';
import { buildCli } from './generated-cli';
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
    .command('build <name>')
    .description('从文档构建一个可全局使用的 CLI')
    .option('--from <source>', '文档来源，本地文件路径或 URL')
    .option('--to <directory>', '生成输出目录')
    .option('--verbose', '打开调试日志')
    .option('--yes', '跳过交互确认，使用默认建议值')
    .action(async (name, options) => {
      if (!options.from) {
        console.error("error: required option '--from <source>' not specified\n");
        program.commands.find((c) => c.name() === 'build')?.help();
        return;
      }
      const result = await buildCli({
        name,
        from: options.from,
        to: options.to,
        verbose: Boolean(options.verbose),
        yes: Boolean(options.yes),
      });

      console.log(`Built CLI ${name}`);
      console.log(`- target: ${result.targetDir}`);
      console.log(`- manifest: ${result.manifestFilePath}`);
      console.log(`- spec: ${result.specFilePath}`);
      if (result.shimFilePath) {
        console.log(`- command: ${result.shimFilePath}`);
      }
      console.log(`- usage: ${name} ${result.commandPath.join(' ')} --help`);
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
