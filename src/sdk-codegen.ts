import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';

import type { SdkLanguage } from './types';
import type { SdkActionDraft, SdkCallConvention, SdkDetection } from './sdk-extractor';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Extract version from a remote package spec.
 *
 * Examples:
 *   "github.com/foo/bar@v1.2.0"  → "v1.2.0"
 *   "requests==1.1.1"            → "==1.1.1" (kept as-is for pip)
 *   "sharp@latest"               → "latest"
 *   "image@0.24"                 → "0.24"
 *   "github.com/foo/bar"         → defaultVersion
 */
function extractRemoteVersion(spec: string, defaultVersion: string): string {
  // Python pip style: ==, >=, ~=, !=
  const pipMatch = spec.match(/[=<>~!]+[\d].*/);
  if (pipMatch) return pipMatch[0];

  // @version style
  const atIdx = spec.lastIndexOf('@');
  if (atIdx > 0) {
    // Don't confuse @scope with @version
    const afterAt = spec.slice(atIdx + 1);
    if (afterAt && !afterAt.includes('/')) return afterAt;
  }

  return defaultVersion;
}

/**
 * Extract module/package name from a remote spec (for codegen context).
 */
function extractRemoteModuleName(spec: string, language: SdkLanguage | string): string {
  if (language === 'go') {
    return spec.split('@')[0];
  }
  if (language === 'python') {
    return spec.split(/[=<>~!]/)[0].trim();
  }
  if (language === 'typescript') {
    if (spec.startsWith('@')) {
      const parts = spec.split('@');
      return parts.length >= 3 ? `@${parts[1]}` : spec;
    }
    return spec.split('@')[0];
  }
  if (language === 'rust') {
    return spec.split('@')[0];
  }
  return spec;
}

export interface SdkBuildConfig {
  command: string;
  requires: string[];
}

export interface SdkCodegenResult {
  generatedFiles: Array<{ relativePath: string; content: string }>;
  buildConfig: SdkBuildConfig;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Generate wrapper CLI source code for the given SDK actions.
 */
export function generateSdkWrapper(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
): SdkCodegenResult {
  const generator = GENERATORS[detection.language];
  return generator(cliName, detection, actions);
}

/**
 * Write generated wrapper files to the target directory.
 */
export async function writeSdkWrapper(
  targetDir: string,
  result: SdkCodegenResult,
): Promise<string[]> {
  const writtenPaths: string[] = [];
  for (const file of result.generatedFiles) {
    const fullPath = path.join(targetDir, file.relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, 'utf8');
    writtenPaths.push(fullPath);
  }
  return writtenPaths;
}

// ── Generators ────────────────────────────────────────────────────────

const GENERATORS: Record<
  SdkLanguage,
  (cliName: string, detection: SdkDetection, actions: SdkActionDraft[]) => SdkCodegenResult
> = {
  go: generateGoWrapper,
  rust: generateRustWrapper,
  typescript: generateTypescriptWrapper,
  python: generatePythonWrapper,
};

// ── Go ────────────────────────────────────────────────────────────────

function generateGoWrapper(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
): SdkCodegenResult {
  const moduleName = detection.moduleName ?? `github.com/user/${cliName}`;
  const wrapperModule = `${moduleName}/cmd/${cliName}`;

  const cases = actions.map((a) => {
    const paramParsing = a.params.map((p) => {
      if (p.type === 'number') {
        return `\t\t${p.name}Str, _ := getFlag(args, "--${p.name}")\n\t\t${p.name}, _ := strconv.Atoi(${p.name}Str)`;
      }
      if (p.type === 'boolean') {
        return `\t\t${p.name}Str, _ := getFlag(args, "--${p.name}")\n\t\t${p.name} := ${p.name}Str == "true"`;
      }
      return `\t\t${p.name}, _ := getFlag(args, "--${p.name}")`;
    }).join('\n');

    const callArgs = a.params.map((p) => p.name).join(', ');
    const invocation = a.receiver
      ? `client.${a.name}(${callArgs})`
      : `sdk.${a.name}(${callArgs})`;

    return `\tcase "${a.name}":\n${paramParsing}\n\t\tresult, err := ${invocation}\n\t\tif err != nil {\n\t\t\tfmt.Fprintf(os.Stderr, "Error: %v\\n", err)\n\t\t\tos.Exit(1)\n\t\t}\n\t\tprintJSON(result)`;
  }).join('\n');

  const mainGo = `package main

import (
\t"encoding/json"
\t"fmt"
\t"os"
\t"strconv"

\tsdk "${moduleName}"
)

func main() {
\tif len(os.Args) < 2 {
\t\tprintUsage()
\t\tos.Exit(1)
\t}

\taction := os.Args[1]
\targs := os.Args[2:]

\tif action == "--help" || action == "-h" {
\t\tprintUsage()
\t\treturn
\t}

\tswitch action {
${cases}
\tdefault:
\t\tfmt.Fprintf(os.Stderr, "Unknown action: %s\\n", action)
\t\tprintUsage()
\t\tos.Exit(1)
\t}
}

func getFlag(args []string, flag string) (string, bool) {
\tfor i, a := range args {
\t\tif a == flag && i+1 < len(args) {
\t\t\treturn args[i+1], true
\t\t}
\t}
\treturn "", false
}

func printJSON(v interface{}) {
\tdata, err := json.MarshalIndent(v, "", "  ")
\tif err != nil {
\t\tfmt.Fprintf(os.Stderr, "JSON error: %v\\n", err)
\t\tos.Exit(1)
\t}
\tfmt.Println(string(data))
}

func printUsage() {
\tfmt.Println("Usage: ${cliName} <action> [flags]")
\tfmt.Println("")
\tfmt.Println("Available actions:")
${actions.map((a) => `\tfmt.Println("  ${a.name}${a.description ? `  - ${a.description}` : ''}")`).join('\n')}
}
`;

  const goMod = detection.isRemote
    ? `module ${wrapperModule}

go 1.21

require ${moduleName} ${extractRemoteVersion(detection.packageSpec ?? '', 'latest')}
`
    : `module ${wrapperModule}

go 1.21

require ${moduleName} v0.0.0

replace ${moduleName} => ${path.relative(path.join(detection.rootDir, 'cmd', cliName), detection.rootDir) || '.'}
`;

  return {
    generatedFiles: [
      { relativePath: 'main.go', content: mainGo },
      { relativePath: 'go.mod', content: goMod },
    ],
    buildConfig: {
      command: 'go build -o {{output}} .',
      requires: ['go>=1.21'],
    },
  };
}

// ── Rust ──────────────────────────────────────────────────────────────

function generateRustWrapper(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
): SdkCodegenResult {
  const crateName = detection.moduleName ?? cliName;

  const matchArms = actions.map((a) => {
    const paramParsing = a.params.map((p) => {
      if (p.type === 'number') {
        return `    let ${p.name}: i64 = get_flag(&args, "--${p.name}").unwrap_or_default().parse().unwrap_or(0);`;
      }
      if (p.type === 'boolean') {
        return `    let ${p.name}: bool = get_flag(&args, "--${p.name}").unwrap_or_default() == "true";`;
      }
      return `    let ${p.name} = get_flag(&args, "--${p.name}").unwrap_or_default();`;
    }).join('\n');

    const callArgs = a.params.map((p) => {
      if (p.type === 'string') return `&${p.name}`;
      return p.name;
    }).join(', ');

    return `        "${a.name}" => {\n${paramParsing}\n            let result = ${crateName.replace(/-/g, '_')}::${a.name}(${callArgs});\n            println!("{}", serde_json::to_string_pretty(&result).unwrap());\n        }`;
  }).join('\n');

  const mainRs = `use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let action = &args[1];
    let args = &args[2..];

    match action.as_str() {
        "--help" | "-h" => print_usage(),
${matchArms}
        _ => {
            eprintln!("Unknown action: {}", action);
            print_usage();
            std::process::exit(1);
        }
    }
}

fn get_flag(args: &[String], flag: &str) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        if a == flag && i + 1 < args.len() {
            return Some(args[i + 1].clone());
        }
    }
    None
}

fn print_usage() {
    println!("Usage: ${cliName} <action> [flags]");
    println!("");
    println!("Available actions:");
${actions.map((a) => `    println!("  ${a.name}${a.description ? `  - ${a.description}` : ''}");`).join('\n')}
}
`;

  const crateRef = detection.isRemote
    ? `"${extractRemoteVersion(detection.packageSpec ?? '', '*')}"`
    : `{ path = "${path.relative(path.join(detection.rootDir, 'wrapper'), detection.rootDir) || '.'}" }`;

  const cargoToml = `[package]
name = "${cliName}"
version = "0.1.0"
edition = "2021"

[dependencies]
${crateName.replace(/-/g, '_')} = ${crateRef}
serde_json = "1"
`;

  return {
    generatedFiles: [
      { relativePath: 'src/main.rs', content: mainRs },
      { relativePath: 'Cargo.toml', content: cargoToml },
    ],
    buildConfig: {
      command: 'cargo build --release && cp target/release/{{name}} {{output}}',
      requires: ['cargo>=1.70'],
    },
  };
}

// ── TypeScript / JavaScript ───────────────────────────────────────────

function generateTypescriptWrapper(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
): SdkCodegenResult {
  const pkgName = detection.moduleName ?? `./${path.relative(process.cwd(), detection.rootDir)}`;

  // Group by receiver (class)
  const classActions = actions.filter((a) => a.receiver);
  const standaloneFns = actions.filter((a) => !a.receiver);
  const classes = [...new Set(classActions.map((a) => a.receiver!))];

  const importParts: string[] = [];
  if (standaloneFns.length > 0) {
    importParts.push(`{ ${standaloneFns.map((a) => a.name).join(', ')} }`);
  }
  if (classes.length > 0) {
    importParts.push(`{ ${classes.join(', ')} }`);
  }
  const importLine = importParts.length > 0
    ? `const sdk = require('${pkgName}');`
    : '';

  const cases = actions.map((a) => {
    const paramParsing = a.params.map((p) => {
      if (p.type === 'number') {
        return `      const ${p.name} = Number(getFlag(args, '--${p.name}') ?? 0);`;
      }
      if (p.type === 'boolean') {
        return `      const ${p.name} = getFlag(args, '--${p.name}') === 'true';`;
      }
      return `      const ${p.name} = getFlag(args, '--${p.name}') ?? '';`;
    }).join('\n');

    const callArgs = a.params.map((p) => p.name).join(', ');
    const invocation = a.receiver
      ? `new sdk.${a.receiver}().${a.name}(${callArgs})`
      : `sdk.${a.name}(${callArgs})`;

    return `    case '${a.name}':\n${paramParsing}\n      result = await ${invocation};\n      break;`;
  }).join('\n');

  const indexJs = `#!/usr/bin/env node
${importLine}

const args = process.argv.slice(2);
const action = args[0];

if (!action || action === '--help' || action === '-h') {
  printUsage();
  process.exit(0);
}

function getFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

function printUsage() {
  console.log('Usage: ${cliName} <action> [flags]');
  console.log('');
  console.log('Available actions:');
${actions.map((a) => `  console.log('  ${a.name}${a.description ? `  - ${a.description}` : ''}');`).join('\n')}
}

async function main() {
  let result;
  switch (action) {
${cases}
    default:
      console.error('Unknown action: ' + action);
      printUsage();
      process.exit(1);
  }
  if (result !== undefined) {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
`;

  const depValue = detection.isRemote
    ? (detection.packageSpec?.split('@')[1] ?? 'latest')
    : `file:${detection.rootDir}`;
  const depName = detection.isRemote
    ? extractRemoteModuleName(detection.packageSpec ?? pkgName, 'typescript')
    : pkgName;

  const pkgJson = JSON.stringify({
    name: cliName,
    version: '0.1.0',
    description: `CLI wrapper for ${pkgName}`,
    bin: { [cliName]: 'index.js' },
    dependencies: {
      [depName]: depValue,
    },
  }, null, 2);

  return {
    generatedFiles: [
      { relativePath: 'index.js', content: indexJs },
      { relativePath: 'package.json', content: pkgJson },
    ],
    buildConfig: {
      command: 'npm install',
      requires: ['node>=18'],
    },
  };
}

// ── Python ────────────────────────────────────────────────────────────

function generatePythonWrapper(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
): SdkCodegenResult {
  const conv = detection.callConvention;

  // If we have a call convention, use the new convention-aware generator
  if (conv) {
    return generatePythonWrapperWithConvention(cliName, detection, actions, conv);
  }

  // Legacy fallback (no convention available)
  return generatePythonWrapperLegacy(cliName, detection, actions);
}

function generatePythonWrapperWithConvention(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
  conv: SdkCallConvention,
): SdkCodegenResult {
  const lines: string[] = [];

  // Shebang and standard imports
  lines.push('#!/usr/bin/env python3');
  lines.push('import sys');
  lines.push('import os');
  lines.push('import json');
  lines.push('');

  // sys.path for local packages
  if (!detection.isRemote && detection.rootDir) {
    lines.push(`sys.path.insert(0, '${detection.rootDir}')`);
    lines.push('');
  }

  // SDK-specific imports from convention
  for (const imp of conv.importStatements) {
    lines.push(imp);
  }
  lines.push('');
  lines.push('');

  // get_flag helper
  lines.push('def get_flag(args, flag):');
  lines.push('    for i, a in enumerate(args):');
  lines.push('        if a == flag and i + 1 < len(args):');
  lines.push('            return args[i + 1]');
  lines.push('    return None');
  lines.push('');
  lines.push('');

  // print_usage
  lines.push('def print_usage():');
  lines.push(`    print('Usage: ${cliName} <action> [flags]')`);
  lines.push("    print('')");
  lines.push("    print('Available actions:')");
  for (const a of actions) {
    const desc = a.description ? `  - ${a.description}` : '';
    lines.push(`    print('  ${a.name}${desc}')`);
  }

  // Print extra CLI flags in usage
  if (conv.extraCliFlags && conv.extraCliFlags.length > 0) {
    lines.push("    print('')");
    lines.push("    print('Global flags:')");
    for (const flag of conv.extraCliFlags) {
      const reqLabel = flag.required ? ' (required)' : '';
      const envHint = flag.envVar ? ` [env: ${flag.envVar}]` : '';
      lines.push(`    print('  --${flag.name}  ${flag.description}${reqLabel}${envHint}')`);
    }
  }
  lines.push('');
  lines.push('');

  // main function
  lines.push('def main():');
  lines.push('    args = sys.argv[1:]');
  lines.push("    if not args or args[0] in ('--help', '-h'):");
  lines.push('        print_usage()');
  lines.push('        return');
  lines.push('');
  lines.push('    action = args[0]');
  lines.push('    args = args[1:]');
  lines.push('');

  // Parse extra CLI flags (e.g. --region)
  if (conv.extraCliFlags && conv.extraCliFlags.length > 0) {
    for (const flag of conv.extraCliFlags) {
      const envFallback = flag.envVar ? ` or os.environ.get('${flag.envVar}')` : '';
      const defaultFallback = flag.defaultValue ? ` or '${flag.defaultValue}'` : '';
      lines.push(`    ${flag.name} = get_flag(args, '--${flag.name}')${envFallback}${defaultFallback}`);
      if (flag.required) {
        lines.push(`    if not ${flag.name}:`);
        lines.push(`        print('Error: --${flag.name} is required${flag.envVar ? ` (or set ${flag.envVar})` : ''}', file=sys.stderr)`);
        lines.push('        sys.exit(1)');
      }
    }
    lines.push('');
  }

  // Auth setup
  if (conv.auth) {
    lines.push('    # Authentication');
    for (const [envVar, desc] of Object.entries(conv.auth.envVars)) {
      lines.push(`    ${envVarToLocal(envVar)} = os.environ.get('${envVar}')`);
      lines.push(`    if not ${envVarToLocal(envVar)}:`);
      lines.push(`        print('Error: ${envVar} environment variable is required (${desc})', file=sys.stderr)`);
      lines.push('        sys.exit(1)');
    }
    // Render auth code template with env var locals
    let authCode = conv.auth.codeTemplate;
    for (const envVar of Object.keys(conv.auth.envVars)) {
      authCode = authCode.replace(new RegExp(`\\{\\{${envVar}\\}\\}`, 'g'), envVarToLocal(envVar));
    }
    lines.push(`    ${conv.auth.outputVar} = ${authCode}`);
    lines.push('');
  }

  // Setup steps (e.g. client instantiation)
  for (const step of conv.setupSteps) {
    lines.push(`    # ${step.label}`);
    // Replace placeholders in code template
    let code = step.codeTemplate;
    // Replace input references (they should already be local variable names)
    lines.push(`    ${code}`);
  }
  if (conv.setupSteps.length > 0) {
    lines.push('');
  }

  // Action dispatch
  lines.push('    result = None');
  lines.push('');
  lines.push('    if False:');
  lines.push('        pass');

  for (const a of actions) {
    lines.push(`    elif action == '${a.name}':`);

    // Parse action-specific params
    for (const p of a.params) {
      if (p.type === 'number') {
        lines.push(`        ${p.name} = int(get_flag(args, '--${p.name}') or '0')`);
      } else if (p.type === 'boolean') {
        lines.push(`        ${p.name} = get_flag(args, '--${p.name}') == 'true'`);
      } else {
        lines.push(`        ${p.name} = get_flag(args, '--${p.name}') or ''`);
      }
    }

    // Generate the call based on convention's callPattern
    if (conv.callPattern.style === 'single-request-object') {
      // Cloud SDK style: construct request object, then call
      if (conv.callPattern.requestPopulateTemplate) {
        let populateCode = conv.callPattern.requestPopulateTemplate;
        // Replace {{action}} with actual action name
        populateCode = populateCode.replace(/\{\{action\}\}/g, a.name);
        // Build args dict from params
        const argsDict = `{${a.params.map((p) => `'${titleCase(p.name)}': ${p.name}`).join(', ')}}`;
        populateCode = populateCode.replace(/\{\{args\}\}/g, argsDict);
        // Each line of populate code gets indented
        for (const pLine of populateCode.split('\n')) {
          lines.push(`        ${pLine}`);
        }
      }
      let callCode = conv.callPattern.codeTemplate;
      callCode = callCode.replace(/\{\{action\}\}/g, a.name);
      callCode = callCode.replace(/\{\{request\}\}/g, 'req');
      callCode = callCode.replace(/\{\{client\}\}/g, 'client');
      lines.push(`        resp = ${callCode}`);
      lines.push('        result = resp');
    } else {
      // kwargs or positional
      let callCode = conv.callPattern.codeTemplate;
      callCode = callCode.replace(/\{\{action\}\}/g, a.name);
      callCode = callCode.replace(/\{\{client\}\}/g, 'client');

      if (conv.callPattern.style === 'kwargs') {
        const kwargs = a.params.map((p) => `${p.name}=${p.name}`).join(', ');
        callCode = callCode.replace(/\{\{args\}\}/g, kwargs);
      } else {
        const positionalArgs = a.params.map((p) => p.name).join(', ');
        callCode = callCode.replace(/\{\{args\}\}/g, positionalArgs);
      }
      lines.push(`        result = ${callCode}`);
    }
  }

  lines.push('    else:');
  lines.push("        print(f'Unknown action: {action}', file=sys.stderr)");
  lines.push('        print_usage()');
  lines.push('        sys.exit(1)');
  lines.push('');
  lines.push('    if result is not None:');
  lines.push("        try:");
  lines.push("            print(json.dumps(result, indent=2, default=str))");
  lines.push("        except TypeError:");
  lines.push("            print(str(result))");
  lines.push('');
  lines.push('');
  lines.push("if __name__ == '__main__':");
  lines.push('    main()');
  lines.push('');

  const mainPy = lines.join('\n');

  const installRequires = detection.isRemote && detection.packageSpec
    ? `\n    install_requires=['${detection.packageSpec}'],`
    : '';

  const setupPy = `from setuptools import setup

setup(
    name='${cliName}',
    version='0.1.0',
    py_modules=['__main__'],${installRequires}
    entry_points={
        'console_scripts': [
            '${cliName}=__main__:main',
        ],
    },
)
`;

  return {
    generatedFiles: [
      { relativePath: '__main__.py', content: mainPy },
      { relativePath: 'setup.py', content: setupPy },
    ],
    buildConfig: {
      command: 'pip install -e .',
      requires: ['python>=3.8'],
    },
  };
}

/** Convert ENV_VAR_NAME to env_var_name (local Python variable) */
function envVarToLocal(envVar: string): string {
  return envVar.toLowerCase();
}

/** Convert param_name to ParamName (for cloud SDK request fields) */
function titleCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function generatePythonWrapperLegacy(
  cliName: string,
  detection: SdkDetection,
  actions: SdkActionDraft[],
): SdkCodegenResult {
  const moduleName = detection.moduleName ?? path.basename(detection.rootDir);

  const cases = actions.map((a) => {
    const paramParsing = a.params.map((p) => {
      if (p.type === 'number') {
        return `        ${p.name} = int(get_flag(args, '--${p.name}') or '0')`;
      }
      if (p.type === 'boolean') {
        return `        ${p.name} = get_flag(args, '--${p.name}') == 'true'`;
      }
      return `        ${p.name} = get_flag(args, '--${p.name}') or ''`;
    }).join('\n');

    const callArgs = a.params.map((p) => `${p.name}=${p.name}`).join(', ');
    const invocation = a.receiver
      ? `${moduleName}.${a.receiver}().${a.name}(${callArgs})`
      : `${moduleName}.${a.name}(${callArgs})`;

    return `    elif action == '${a.name}':\n${paramParsing}\n        result = ${invocation}`;
  }).join('\n');

  const sysPathLine = detection.isRemote
    ? ''
    : `sys.path.insert(0, '${detection.rootDir}')`;

  const mainPy = `#!/usr/bin/env python3
import sys
import json

${sysPathLine}
import ${moduleName}


def get_flag(args, flag):
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return args[i + 1]
    return None


def print_usage():
    print('Usage: ${cliName} <action> [flags]')
    print('')
    print('Available actions:')
${actions.map((a) => `    print('  ${a.name}${a.description ? `  - ${a.description}` : ''}')`).join('\n')}


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('--help', '-h'):
        print_usage()
        return

    action = args[0]
    args = args[1:]
    result = None

    if False:
        pass
${cases}
    else:
        print(f'Unknown action: {action}', file=sys.stderr)
        print_usage()
        sys.exit(1)

    if result is not None:
        print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()
`;

  const installRequires = detection.isRemote && detection.packageSpec
    ? `\n    install_requires=['${detection.packageSpec}'],`
    : '';

  const setupPy = `from setuptools import setup

setup(
    name='${cliName}',
    version='0.1.0',
    py_modules=['__main__'],${installRequires}
    entry_points={
        'console_scripts': [
            '${cliName}=__main__:main',
        ],
    },
)
`;

  return {
    generatedFiles: [
      { relativePath: '__main__.py', content: mainPy },
      { relativePath: 'setup.py', content: setupPy },
    ],
    buildConfig: {
      command: 'pip install -e .',
      requires: ['python>=3.8'],
    },
  };
}
