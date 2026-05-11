import { execFile } from 'node:child_process';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ParamType, SdkLanguage, SdkSourceSpec } from './types';
import { collectFiles, fileExists } from './utils';

const execFileAsync = promisify(execFile);

// ── Public types ──────────────────────────────────────────────────────

export interface SdkParamSpec {
  name: string;
  type: ParamType;
  required: boolean;
  description?: string;
  rawType?: string; // original language type, e.g. "int64", "Vec<String>"
}

export interface SdkActionDraft {
  name: string;
  description?: string;
  params: SdkParamSpec[];
  returnType?: string;
  receiver?: string; // e.g. "*Client" for Go methods
  filePath: string;  // source file where this action was found
}

export interface SdkDetection {
  language: SdkLanguage;
  rootDir: string;
  entryFiles: string[];
  moduleName?: string; // go module name, package.json name, etc.
  /** When --from used a remote package spec (e.g. "requests==1.1.1"), stored here */
  packageSpec?: string;
  /** True when the source is a remote package (not a local directory) */
  isRemote?: boolean;
  /** Call convention inferred by static analysis + AI — describes how to call this SDK */
  callConvention?: SdkCallConvention;
}

// ── SDK Call Convention (two-layer inference) ─────────────────────────

/** A single step in the SDK invocation chain */
export interface SdkCallStep {
  /** Step kind */
  kind: 'import' | 'instantiate' | 'construct_request' | 'call';
  /** Human-readable label, e.g. "Create credential" */
  label: string;
  /** Python/Go/TS code template with {{placeholders}} */
  codeTemplate: string;
  /** Variables this step produces (available to later steps) */
  outputs?: string[];
  /** Variables this step consumes (must be produced by earlier steps) */
  inputs?: string[];
}

/** Environment variable mapping for authentication */
export interface SdkAuthConfig {
  /** Env var name → description, e.g. { "TENCENTCLOUD_SECRET_ID": "API Secret ID" } */
  envVars: Record<string, string>;
  /** Code template to construct the auth/credential object */
  codeTemplate: string;
  /** Variable name the auth object is assigned to */
  outputVar: string;
}

/** Describes how to call a particular SDK — the core output of two-layer inference */
export interface SdkCallConvention {
  /** High-level SDK category */
  kind: 'simple-function' | 'simple-class' | 'cloud-sdk' | 'custom';

  /** Full import statements needed (language-specific) */
  importStatements: string[];

  /** Auth configuration — undefined if SDK needs no auth */
  auth?: SdkAuthConfig;

  /** Ordered steps to set up and call the SDK (excluding imports & auth) */
  setupSteps: SdkCallStep[];

  /** How each action method should be called */
  callPattern: {
    /** 'single-request-object' = cloud SDK style; 'kwargs' = direct params; 'positional' = ordered args */
    style: 'single-request-object' | 'kwargs' | 'positional';
    /**
     * Code template for the action call.
     * Placeholders: {{client}}, {{action}}, {{request}}, {{args}}
     */
    codeTemplate: string;
    /** For 'single-request-object': suffix to derive request class name from action name */
    requestClassSuffix?: string;
    /** For 'single-request-object': how to populate the request object */
    requestPopulateTemplate?: string;
  };

  /** Additional CLI flags this SDK needs (e.g. --region for cloud SDKs) */
  extraCliFlags?: Array<{
    name: string;
    description: string;
    required: boolean;
    envVar?: string;
    defaultValue?: string;
  }>;

  /** Confidence score (0-1) — 1.0 for static-only inference, may be lower for AI */
  confidence: number;
  /** Source of the inference */
  inferredBy: 'static' | 'ai' | 'static+ai';
}

// ── Static structure snapshot (first layer output, AI input) ──────────

/** Raw structural facts extracted from source code — fed to AI for inference */
export interface SdkStructureSnapshot {
  language: SdkLanguage;
  packageName?: string;
  /** Top-level importable module name (may differ from pip package name) */
  topLevelModule?: string;
  /** Classes found, with inheritance and __init__ info */
  classes: Array<{
    name: string;
    filePath: string;
    baseClasses: string[];
    initParams: SdkParamSpec[];
    methods: Array<{
      name: string;
      params: SdkParamSpec[];
      returnType?: string;
      docstring?: string;
    }>;
  }>;
  /** Standalone functions found */
  standaloneFunctions: Array<{
    name: string;
    filePath: string;
    params: SdkParamSpec[];
    returnType?: string;
    docstring?: string;
  }>;
  /** Notable files (e.g. models.py, types.py) */
  notableFiles: string[];
  /** File tree summary (relative paths) */
  fileTree: string[];
}

// ── Language detection ────────────────────────────────────────────────

const LANGUAGE_MARKERS: Array<{ language: SdkLanguage; markers: string[] }> = [
  { language: 'go', markers: ['go.mod'] },
  { language: 'rust', markers: ['Cargo.toml'] },
  { language: 'typescript', markers: ['tsconfig.json', 'package.json'] },
  { language: 'python', markers: ['setup.py', 'setup.cfg', 'pyproject.toml', '__init__.py'] },
];

const EXTENSION_MAP: Record<string, SdkLanguage> = {
  '.go': 'go',
  '.rs': 'rust',
  '.ts': 'typescript',
  '.js': 'typescript', // treat JS as TS for extraction purposes
  '.mjs': 'typescript',
  '.py': 'python',
};

/**
 * Detect whether `from` is an SDK source and which language it is.
 * Returns null if not an SDK source.
 *
 * When `languageHint` is provided, it takes priority over auto-detection.
 * When `sourceSpec` is provided with `isRemote: true`, returns a detection
 * that references a remote package (no local files to scan yet).
 */
export async function detectSdk(
  from: string,
  languageHint?: SdkLanguage,
  sourceSpec?: SdkSourceSpec,
): Promise<SdkDetection | null> {
  // Remote package mode: lang:packageName@version
  // No local directory to scan — we just record the intent
  if (sourceSpec?.isRemote) {
    return {
      language: sourceSpec.language,
      rootDir: '', // will be populated after package download / go get
      entryFiles: [],
      moduleName: extractRemoteModuleName(sourceSpec.spec, sourceSpec.language),
      packageSpec: sourceSpec.spec,
      isRemote: true,
    };
  }

  const resolved = path.resolve(from);

  // Check if it's a single file
  try {
    const s = await stat(resolved);
    if (s.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const lang = languageHint ?? EXTENSION_MAP[ext];
      if (!lang) return null;
      return {
        language: lang,
        rootDir: path.dirname(resolved),
        entryFiles: [resolved],
      };
    }
  } catch {
    return null;
  }

  // It's a directory — detect language from marker files
  if (languageHint) {
    const entryFiles = await collectSdkFiles(resolved, languageHint);
    if (entryFiles.length === 0) return null;
    const moduleName = await detectModuleName(resolved, languageHint);
    return { language: languageHint, rootDir: resolved, entryFiles, moduleName };
  }

  // Auto-detect
  for (const { language, markers } of LANGUAGE_MARKERS) {
    for (const marker of markers) {
      if (await fileExists(path.join(resolved, marker))) {
        // For package.json, check it's not just a random node project
        // but actually has TS/JS source
        if (marker === 'package.json' && language === 'typescript') {
          const tsFiles = await collectSdkFiles(resolved, 'typescript');
          if (tsFiles.length === 0) continue;
        }
        const entryFiles = await collectSdkFiles(resolved, language);
        if (entryFiles.length === 0) continue;
        const moduleName = await detectModuleName(resolved, language);
        return { language, rootDir: resolved, entryFiles, moduleName };
      }
    }
  }

  return null;
}

async function collectSdkFiles(dir: string, language: SdkLanguage): Promise<string[]> {
  const extMap: Record<SdkLanguage, string[]> = {
    go: ['.go'],
    rust: ['.rs'],
    typescript: ['.ts', '.js', '.mjs'],
    python: ['.py'],
  };
  const extensions = extMap[language];
  return collectFiles(dir, (f) => {
    const ext = path.extname(f).toLowerCase();
    // Skip test files and vendor/node_modules
    if (f.includes('node_modules') || f.includes('vendor') || f.includes('__pycache__')) {
      return false;
    }
    if (f.includes('_test.go') || f.includes('.test.') || f.includes('.spec.') || f.includes('test_')) {
      return false;
    }
    return extensions.includes(ext);
  });
}

async function detectModuleName(dir: string, language: SdkLanguage): Promise<string | undefined> {
  try {
    if (language === 'go') {
      const gomod = await readFile(path.join(dir, 'go.mod'), 'utf8');
      const match = gomod.match(/^module\s+(.+)$/m);
      return match?.[1]?.trim();
    }
    if (language === 'typescript') {
      const pkgJson = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      return pkgJson.name;
    }
    if (language === 'rust') {
      const cargo = await readFile(path.join(dir, 'Cargo.toml'), 'utf8');
      const match = cargo.match(/^name\s*=\s*"(.+)"/m);
      return match?.[1];
    }
    if (language === 'python') {
      // Try pyproject.toml first
      if (await fileExists(path.join(dir, 'pyproject.toml'))) {
        const content = await readFile(path.join(dir, 'pyproject.toml'), 'utf8');
        const match = content.match(/^name\s*=\s*"(.+)"/m);
        if (match) return match[1];
      }
      // Fall back to directory name
      return path.basename(dir);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Extract a human-readable module name from a remote package specifier.
 *
 * Examples:
 *   "github.com/foo/bar"     → "bar"
 *   "requests==1.1.1"        → "requests"
 *   "sharp@latest"           → "sharp"
 *   "@scope/pkg@1.0"         → "@scope/pkg"
 *   "image@0.24"             → "image"
 */
function extractRemoteModuleName(spec: string, language: SdkLanguage): string {
  if (language === 'go') {
    // Go module path: github.com/foo/bar → bar
    return spec.split('/').pop() ?? spec;
  }
  if (language === 'python') {
    // pip format: requests==1.1.1, requests>=2.0, requests~=1.0
    return spec.split(/[=<>~!]/)[0].trim();
  }
  if (language === 'typescript') {
    // npm format: sharp@latest, @scope/pkg@1.0.0
    if (spec.startsWith('@')) {
      // scoped: @scope/pkg@version → @scope/pkg
      const parts = spec.split('@');
      // parts = ['', 'scope/pkg', 'version']
      return parts.length >= 3 ? `@${parts[1]}` : spec;
    }
    // unscoped: sharp@latest → sharp
    return spec.split('@')[0];
  }
  if (language === 'rust') {
    // crates.io: image@0.24 → image
    return spec.split('@')[0];
  }
  return spec;
}

// ── Remote package fetching ───────────────────────────────────────────

/**
 * Download / install a remote package into a temporary directory and populate
 * the SdkDetection with actual rootDir + entryFiles.
 *
 * After calling this, detection.rootDir and detection.entryFiles will be filled,
 * and detection.isRemote will be set to false so downstream code treats it as local.
 *
 * The caller is responsible for cleaning up `detection.rootDir` if needed.
 */
export async function fetchRemotePackage(detection: SdkDetection): Promise<void> {
  if (!detection.isRemote || !detection.packageSpec) return;

  const tmpBase = path.join(os.tmpdir(), 'clix-remote-');
  const tmpDir = await mkdtemp(tmpBase);

  try {
    if (detection.language === 'python') {
      await fetchPythonPackage(detection, tmpDir);
    } else if (detection.language === 'typescript') {
      await fetchNpmPackage(detection, tmpDir);
    } else if (detection.language === 'go') {
      await fetchGoPackage(detection, tmpDir);
    } else if (detection.language === 'rust') {
      await fetchRustPackage(detection, tmpDir);
    } else {
      throw new Error(`不支持远程获取 ${detection.language} 包`);
    }
  } catch (err) {
    // Clean up on failure
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * pip download --no-deps --no-binary :all: <spec> → extract source into tmpDir
 */
async function fetchPythonPackage(detection: SdkDetection, tmpDir: string): Promise<void> {
  const spec = detection.packageSpec!;
  const downloadDir = path.join(tmpDir, 'download');
  const extractDir = path.join(tmpDir, 'src');

  // pip download the source
  await execFileAsync('pip', [
    'download', '--no-deps', '--no-binary', ':all:',
    '-d', downloadDir,
    spec,
  ], { timeout: 120_000 });

  // Find downloaded .tar.gz or .zip
  const downloaded = await collectFiles(downloadDir, () => true);
  if (downloaded.length === 0) {
    throw new Error(`pip download 未找到文件: ${spec}`);
  }

  const archive = downloaded[0];
  // Extract
  await execFileAsync('mkdir', ['-p', extractDir]);

  if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz')) {
    await execFileAsync('tar', ['-xzf', archive, '-C', extractDir]);
  } else if (archive.endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', archive, '-d', extractDir]);
  } else if (archive.endsWith('.whl')) {
    // .whl is a zip file
    await execFileAsync('unzip', ['-q', archive, '-d', extractDir]);
  } else {
    throw new Error(`不支持的归档格式: ${path.basename(archive)}`);
  }

  // Find the actual Python package directory inside extractDir
  const srcRoot = await findPythonSourceRoot(extractDir, detection.moduleName ?? '');

  detection.rootDir = srcRoot;
  detection.entryFiles = await collectSdkFiles(srcRoot, 'python');
  detection.isRemote = false;
}

/**
 * Find the Python package root inside an extracted archive.
 * Typical structure: extractDir/packagename-1.0.0/tencentcloud/...
 */
async function findPythonSourceRoot(extractDir: string, moduleName: string): Promise<string> {
  const entries = await collectFiles(extractDir, (f) => f.endsWith('__init__.py'));

  if (entries.length === 0) {
    // Might be a flat module, just use extractDir
    const pyFiles = await collectFiles(extractDir, (f) => f.endsWith('.py'));
    if (pyFiles.length > 0) return extractDir;
    throw new Error('下载的包中未找到 Python 源文件');
  }

  // Find the top-level package closest to module name
  // Sort by depth (shallowest first)
  entries.sort((a, b) => a.split('/').length - b.split('/').length);

  // Prefer an __init__.py whose parent dir name matches the module name
  const nameNorm = moduleName.replace(/-/g, '_').replace(/\./g, '_').toLowerCase();
  for (const entry of entries) {
    const parentDir = path.basename(path.dirname(entry)).toLowerCase().replace(/-/g, '_');
    if (parentDir === nameNorm || nameNorm.includes(parentDir)) {
      // Return the grandparent so we include the package dir
      return path.dirname(path.dirname(entry));
    }
  }

  // Fallback: return the directory containing the shallowest __init__.py's parent
  return path.dirname(path.dirname(entries[0]));
}

/**
 * npm pack <spec> → extract tarball into tmpDir
 */
async function fetchNpmPackage(detection: SdkDetection, tmpDir: string): Promise<void> {
  const spec = detection.packageSpec!;

  // npm pack downloads a tarball
  const { stdout } = await execFileAsync('npm', ['pack', spec, '--pack-destination', tmpDir], {
    timeout: 120_000,
    cwd: tmpDir,
  });

  const tarName = stdout.trim().split('\n').pop()!;
  const tarPath = path.join(tmpDir, tarName);
  const extractDir = path.join(tmpDir, 'package');

  await execFileAsync('tar', ['-xzf', tarPath, '-C', tmpDir]);

  detection.rootDir = extractDir;
  detection.entryFiles = await collectSdkFiles(extractDir, 'typescript');
  detection.isRemote = false;
}

/**
 * go mod download → fetch module source to a temp go workspace
 */
async function fetchGoPackage(detection: SdkDetection, tmpDir: string): Promise<void> {
  const spec = detection.packageSpec!;
  const modPath = spec.includes('@') ? spec : `${spec}@latest`;

  // Create a minimal go.mod
  await execFileAsync('go', ['mod', 'init', 'clix-tmp-fetcher'], { cwd: tmpDir });
  await execFileAsync('go', ['get', modPath], { cwd: tmpDir, timeout: 120_000 });

  // Find the downloaded module source in GOMODCACHE
  const { stdout: gopath } = await execFileAsync('go', ['env', 'GOMODCACHE']);
  const modCache = gopath.trim();

  // Module path without version
  const modBase = spec.split('@')[0];
  // Find the actual directory in mod cache
  const modDir = await findGoModDir(modCache, modBase);

  if (!modDir) {
    throw new Error(`在 GOMODCACHE 中未找到模块: ${modBase}`);
  }

  detection.rootDir = modDir;
  detection.entryFiles = await collectSdkFiles(modDir, 'go');
  detection.isRemote = false;
}

async function findGoModDir(modCache: string, modPath: string): Promise<string | null> {
  // Go mod cache structure: $GOMODCACHE/github.com/foo/bar@v1.0.0
  const parts = modPath.split('/');
  let searchDir = modCache;

  for (const part of parts) {
    searchDir = path.join(searchDir, part);
  }

  // Look for versioned directories
  try {
    const { readdir } = await import('node:fs/promises');
    const parent = path.dirname(searchDir);
    const baseName = path.basename(searchDir);
    const entries = await readdir(parent);
    const match = entries.find((e) => e.startsWith(baseName + '@') || e === baseName);
    if (match) return path.join(parent, match);
  } catch {
    // Not found
  }
  return null;
}

/**
 * cargo download → fetch crate source
 */
async function fetchRustPackage(detection: SdkDetection, tmpDir: string): Promise<void> {
  const spec = detection.packageSpec!;
  const crateName = spec.split('@')[0];
  const version = spec.includes('@') ? spec.split('@')[1] : '';

  const args = ['download', crateName];
  if (version) args.push(`--version=${version}`);
  args.push('--extract', `--output=${tmpDir}/src`);

  try {
    await execFileAsync('cargo', args, { timeout: 120_000, cwd: tmpDir });
  } catch {
    // cargo-download might not be installed, fallback to manual download
    throw new Error(
      `无法下载 Rust crate "${crateName}"。请确保已安装 cargo-download:\n` +
      `  cargo install cargo-download`,
    );
  }

  const srcDir = path.join(tmpDir, 'src');
  detection.rootDir = srcDir;
  detection.entryFiles = await collectSdkFiles(srcDir, 'rust');
  detection.isRemote = false;
}

// ── Extraction ────────────────────────────────────────────────────────

/**
 * Extract public SDK actions from source files.
 * Also performs two-layer call convention inference (static + AI)
 * and stores the result in detection.callConvention.
 */
export async function extractSdkActions(detection: SdkDetection): Promise<SdkActionDraft[]> {
  const extractor = EXTRACTORS[detection.language];
  const allActions: SdkActionDraft[] = [];

  for (const filePath of detection.entryFiles) {
    const content = await readFile(filePath, 'utf8');
    const actions = extractor(content, filePath);
    allActions.push(...actions);
  }

  // Two-layer call convention inference
  if (!detection.callConvention) {
    try {
      const snapshot = await extractStructureSnapshot(detection);
      detection.callConvention = await inferCallConvention(snapshot);
    } catch {
      // Non-fatal: wrapper generation will fall back to legacy behavior
    }
  }

  // Apply heuristic filter: remove constructors, setters, getters, etc.
  // Then deduplicate by (name + receiver) — prefer sync over async, first seen wins.
  const filtered = filterCandidateActions(allActions);
  return deduplicateActions(filtered);
}

const EXTRACTORS: Record<SdkLanguage, (content: string, filePath: string) => SdkActionDraft[]> = {
  go: extractGoActions,
  rust: extractRustActions,
  typescript: extractTypescriptActions,
  python: extractPythonActions,
};

// ── Go extractor ──────────────────────────────────────────────────────

function extractGoActions(content: string, filePath: string): SdkActionDraft[] {
  const actions: SdkActionDraft[] = [];

  // Match exported functions and methods:
  // func FunctionName(params) returns
  // func (r *Receiver) MethodName(params) returns
  const funcRegex = /(?:\/\/\s*(.+)\n)?func\s+(?:\((\w+)\s+(\*?\w+)\)\s+)?([A-Z]\w*)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+(\S[^\n{]*))?/g;

  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(content)) !== null) {
    const comment = match[1]?.trim();
    const receiverType = match[3];
    const funcName = match[4];
    const paramsStr = match[5];
    const returnsMulti = match[6];
    const returnsSingle = match[7];

    const params = parseGoParams(paramsStr);
    const returnType = (returnsMulti ?? returnsSingle)?.trim();

    actions.push({
      name: funcName,
      description: comment,
      params,
      returnType,
      receiver: receiverType,
      filePath,
    });
  }

  return actions;
}

function parseGoParams(paramsStr: string): SdkParamSpec[] {
  if (!paramsStr.trim()) return [];
  const params: SdkParamSpec[] = [];

  // Go params: name type, name type, ...
  // Also handle: name, name2 type (grouped names)
  const segments = paramsStr.split(',').map((s) => s.trim()).filter(Boolean);

  // Accumulate names that don't have a type yet
  const pendingNames: string[] = [];

  for (const seg of segments) {
    const parts = seg.trim().split(/\s+/);
    if (parts.length >= 2) {
      // This segment has a type — assign it to all pending + current name
      const rawType = parts.slice(1).join(' ');
      const paramType = mapGoType(rawType);
      for (const pn of pendingNames) {
        params.push({ name: pn, type: paramType, required: true, rawType });
      }
      pendingNames.length = 0;
      params.push({ name: parts[0], type: paramType, required: true, rawType });
    } else {
      // Just a name, type comes later
      pendingNames.push(parts[0]);
    }
  }

  return params;
}

function mapGoType(rawType: string): ParamType {
  const t = rawType.replace(/^\*/, '').toLowerCase();
  if (['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64'].includes(t)) {
    return 'number';
  }
  if (t === 'bool') return 'boolean';
  if (t === 'string') return 'string';
  if (t.startsWith('[]') || t.startsWith('...')) return 'array';
  if (t.startsWith('map[')) return 'object';
  return 'object'; // structs, interfaces, etc.
}

// ── Rust extractor ────────────────────────────────────────────────────

function extractRustActions(content: string, filePath: string): SdkActionDraft[] {
  const actions: SdkActionDraft[] = [];

  // Match: pub fn name(params) -> ReturnType
  // With optional doc comments (/// ...)
  const funcRegex = /((?:\/\/\/\s*.+\n)*)[ \t]*pub\s+(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n{]+))?/g;

  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(content)) !== null) {
    const docComments = match[1];
    const funcName = match[2];
    const paramsStr = match[3];
    const returnType = match[4]?.trim();

    // Extract description from doc comments
    const description = docComments
      ? docComments.split('\n')
          .map((line) => line.replace(/^\s*\/\/\/\s?/, '').trim())
          .filter(Boolean)
          .join(' ')
      : undefined;

    const params = parseRustParams(paramsStr);

    actions.push({
      name: funcName,
      description,
      params,
      returnType,
      filePath,
    });
  }

  return actions;
}

function parseRustParams(paramsStr: string): SdkParamSpec[] {
  if (!paramsStr.trim()) return [];
  const params: SdkParamSpec[] = [];

  // Split on commas, but be careful with generic types like HashMap<K, V>
  const segments = smartSplitParams(paramsStr);

  for (const seg of segments) {
    const trimmed = seg.trim();
    // Skip self/&self/&mut self
    if (/^&?\s*(?:mut\s+)?self$/.test(trimmed)) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const name = trimmed.slice(0, colonIdx).trim().replace(/^mut\s+/, '');
    const rawType = trimmed.slice(colonIdx + 1).trim();
    const paramType = mapRustType(rawType);

    params.push({ name, type: paramType, required: !rawType.startsWith('Option<'), rawType });
  }

  return params;
}

function mapRustType(rawType: string): ParamType {
  const t = rawType.replace(/^&\s*(?:mut\s+)?/, '').replace(/^Option<(.+)>$/, '$1').trim().toLowerCase();
  if (['i8', 'i16', 'i32', 'i64', 'i128', 'u8', 'u16', 'u32', 'u64', 'u128', 'f32', 'f64', 'isize', 'usize'].includes(t)) {
    return 'number';
  }
  if (t === 'bool') return 'boolean';
  if (t === 'string' || t === '&str' || t === 'str') return 'string';
  if (t.startsWith('vec<') || t.startsWith('[')) return 'array';
  if (t.startsWith('hashmap<') || t.startsWith('btreemap<')) return 'object';
  return 'object';
}

// ── TypeScript / JavaScript extractor ─────────────────────────────────

function extractTypescriptActions(content: string, filePath: string): SdkActionDraft[] {
  const actions: SdkActionDraft[] = [];

  // Match exported functions:
  // export function name(params): ReturnType
  // export async function name(params): ReturnType
  // Also arrow: export const name = (params) => ...
  // Also class methods that are exported

  // 1. Regular exported functions
  const funcRegex = /((?:\/\*\*[\s\S]*?\*\/\s*)?(?:\/\/\s*.+\n)?)export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(content)) !== null) {
    const docBlock = match[1];
    const funcName = match[2];
    const paramsStr = match[3];
    const returnType = match[4]?.trim();

    const description = extractJsDocDescription(docBlock);
    const params = parseTsParams(paramsStr);

    actions.push({ name: funcName, description, params, returnType, filePath });
  }

  // 2. Exported arrow functions: export const name = (params): RetType => ...
  const arrowRegex = /((?:\/\*\*[\s\S]*?\*\/\s*)?(?:\/\/\s*.+\n)?)export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)(?:\s*:\s*([^=>\n]+))?\s*=>/g;
  while ((match = arrowRegex.exec(content)) !== null) {
    const docBlock = match[1];
    const funcName = match[2];
    const paramsStr = match[3];
    const returnType = match[4]?.trim();

    const description = extractJsDocDescription(docBlock);
    const params = parseTsParams(paramsStr);

    actions.push({ name: funcName, description, params, returnType, filePath });
  }

  // 3. Exported class methods (simplified: look for public methods in exported classes)
  const classRegex = /export\s+class\s+(\w+)[\s\S]*?\{([\s\S]*?)\n\}/g;
  while ((match = classRegex.exec(content)) !== null) {
    const className = match[1];
    const classBody = match[2];

    const methodRegex = /((?:\/\*\*[\s\S]*?\*\/\s*)?)(?:public\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodRegex.exec(classBody)) !== null) {
      const docBlock = methodMatch[1];
      const methodName = methodMatch[2];
      const paramsStr = methodMatch[3];
      const returnType = methodMatch[4]?.trim();

      // Skip constructor, private-by-convention, and common non-action methods
      if (methodName === 'constructor' || methodName.startsWith('_') || methodName.startsWith('#')) {
        continue;
      }
      // Skip if explicitly marked private/protected
      if (/(?:private|protected)\s/.test(methodMatch[0])) continue;

      const description = extractJsDocDescription(docBlock);
      const params = parseTsParams(paramsStr);

      actions.push({
        name: methodName,
        description,
        params,
        returnType,
        receiver: className,
        filePath,
      });
    }
  }

  return actions;
}

function extractJsDocDescription(docBlock: string): string | undefined {
  if (!docBlock) return undefined;
  // Extract from /** ... */
  const jsdocMatch = docBlock.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (jsdocMatch) {
    const lines = jsdocMatch[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter((l) => !l.startsWith('@'))
      .filter(Boolean);
    return lines.join(' ') || undefined;
  }
  // Extract from // comment
  const lineMatch = docBlock.match(/\/\/\s*(.+)/);
  return lineMatch?.[1]?.trim();
}

function parseTsParams(paramsStr: string): SdkParamSpec[] {
  if (!paramsStr.trim()) return [];
  const params: SdkParamSpec[] = [];
  const segments = smartSplitParams(paramsStr);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    // Handle destructured params: { a, b }: Type
    if (trimmed.startsWith('{')) continue;

    // Handle rest params: ...args: string[]
    const isRest = trimmed.startsWith('...');
    const clean = isRest ? trimmed.slice(3) : trimmed;

    const colonIdx = findTypeColon(clean);
    let name: string;
    let rawType: string | undefined;
    let required = true;

    if (colonIdx !== -1) {
      name = clean.slice(0, colonIdx).trim();
      rawType = clean.slice(colonIdx + 1).trim();
    } else {
      name = clean.trim();
    }

    // Optional param: name?
    if (name.endsWith('?')) {
      name = name.slice(0, -1);
      required = false;
    }

    const paramType = rawType ? mapTsType(rawType) : (isRest ? 'array' : 'unknown');

    params.push({ name, type: paramType, required, rawType });
  }

  return params;
}

function findTypeColon(str: string): number {
  // Find the colon that separates name from type, ignoring colons inside generics
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

function mapTsType(rawType: string): ParamType {
  const t = rawType.trim().toLowerCase();
  if (t === 'number' || t === 'bigint') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'string') return 'string';
  if (t.endsWith('[]') || t.startsWith('array<') || t.startsWith('readonly ')) return 'array';
  if (t.startsWith('record<') || t.startsWith('map<') || t === 'object') return 'object';
  return 'object';
}

// ── Python extractor ──────────────────────────────────────────────────

function extractPythonActions(content: string, filePath: string): SdkActionDraft[] {
  const actions: SdkActionDraft[] = [];

  // Check for __all__ to determine public API
  const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
  const allowedNames = allMatch
    ? allMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    : null;

  // Detect if this file is a models/types file (full of Request/Response dataclasses)
  // rather than an API client file. For such files, skip extraction entirely.
  const baseName = path.basename(filePath, '.py');
  if (isPythonModelFile(content, baseName)) {
    return actions;
  }

  // Match: def function_name(params) -> ReturnType:
  // Also: async def function_name(params) -> ReturnType:
  // With optional docstring
  const funcRegex = /^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?:/gm;

  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(content)) !== null) {
    const funcName = match[1];
    const paramsStr = match[2];
    const returnType = match[3]?.trim();

    // Skip private functions (leading underscore)
    if (funcName.startsWith('_')) continue;

    // If __all__ is defined, only include listed functions
    if (allowedNames && !allowedNames.includes(funcName)) continue;

    // Skip @property and @xxx.setter decorated methods
    const beforeFunc = content.slice(0, match.index);
    if (isPythonPropertyOrSetter(beforeFunc)) continue;

    // Try to extract docstring
    const afterFunc = content.slice(match.index + match[0].length);
    const description = extractPythonDocstring(afterFunc);

    const params = parsePythonParams(paramsStr);

    // Determine receiver (class method detection)
    const classMatch = beforeFunc.match(/^class\s+(\w+)[^:]*:\s*$/m);
    const indent = match[0].match(/^([ \t]*)/)?.[1] ?? '';
    const receiver = indent.length >= 4 ? classMatch?.[1] : undefined;

    actions.push({ name: funcName, description, params, returnType, receiver, filePath });
  }

  return actions;
}

/**
 * Detect if a Python file is primarily a models/types definition file
 * (e.g. tencentcloud SDK `models.py`, boto3 type stubs, etc.)
 *
 * Heuristics:
 *   - Filename is "models", "types", "schemas", "dataclasses"
 *   - File has many `@property` decorators relative to `def ` count
 *   - File has many classes ending in Request/Response/Model
 */
function isPythonModelFile(content: string, baseName: string): boolean {
  // Name-based detection
  const modelNames = ['models', 'model', 'types', 'schemas', 'dataclasses', 'entities'];
  if (modelNames.includes(baseName.toLowerCase())) return true;

  // Content-based: if @property appears more than regular def methods, it's a model file
  const propertyCount = (content.match(/@property/g) ?? []).length;
  const defCount = (content.match(/^\s*def\s+/gm) ?? []).length;
  if (propertyCount > 10 && propertyCount > defCount * 0.3) return true;

  // Content-based: many Request/Response classes
  const reqRespClasses = (content.match(/class\s+\w+(?:Request|Response|Model)\b/g) ?? []).length;
  if (reqRespClasses > 5) return true;

  return false;
}

/**
 * Check if the text immediately before a `def` is a `@property` or `@xxx.setter` decorator.
 */
function isPythonPropertyOrSetter(beforeFunc: string): boolean {
  // Get the last few non-empty lines before the def
  const lines = beforeFunc.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Check for decorator
    if (line.startsWith('@')) {
      if (line === '@property') return true;
      if (/^@\w+\.setter\b/.test(line)) return true;
      if (/^@\w+\.getter\b/.test(line)) return true;
      if (/^@\w+\.deleter\b/.test(line)) return true;
      // Other decorators (like @staticmethod) — stop looking
      return false;
    }
    // If we hit a non-decorator, non-empty line, stop
    break;
  }
  return false;
}

function extractPythonDocstring(afterFunc: string): string | undefined {
  // Look for triple-quoted string immediately after the function def
  const docMatch = afterFunc.match(/^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
  if (!docMatch) return undefined;
  const raw = (docMatch[1] ?? docMatch[2]).trim();
  // Take first line or first paragraph
  const firstPara = raw.split(/\n\s*\n/)[0];
  return firstPara.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') || undefined;
}

function parsePythonParams(paramsStr: string): SdkParamSpec[] {
  if (!paramsStr.trim()) return [];
  const params: SdkParamSpec[] = [];
  const segments = smartSplitParams(paramsStr);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    // Skip self, cls
    if (trimmed === 'self' || trimmed === 'cls') continue;
    // Skip *args, **kwargs
    if (trimmed.startsWith('*')) continue;

    // Handle: name: type = default
    const eqIdx = trimmed.indexOf('=');
    const withoutDefault = eqIdx !== -1 ? trimmed.slice(0, eqIdx).trim() : trimmed;
    const required = eqIdx === -1;

    const colonIdx = withoutDefault.indexOf(':');
    let name: string;
    let rawType: string | undefined;

    if (colonIdx !== -1) {
      name = withoutDefault.slice(0, colonIdx).trim();
      rawType = withoutDefault.slice(colonIdx + 1).trim();
    } else {
      name = withoutDefault.trim();
    }

    const paramType = rawType ? mapPythonType(rawType) : 'unknown';

    params.push({ name, type: paramType, required, rawType });
  }

  return params;
}

function mapPythonType(rawType: string): ParamType {
  const t = rawType.trim().toLowerCase();
  if (t === 'int' || t === 'float' || t === 'complex') return 'number';
  if (t === 'bool') return 'boolean';
  if (t === 'str' || t === 'bytes') return 'string';
  if (t.startsWith('list[') || t.startsWith('tuple[') || t.startsWith('set[') || t === 'list' || t === 'tuple') return 'array';
  if (t.startsWith('dict[') || t === 'dict') return 'object';
  if (t.startsWith('optional[')) {
    const inner = rawType.trim().slice(9, -1);
    return mapPythonType(inner);
  }
  return 'object';
}

// ── Heuristic filter ──────────────────────────────────────────────────

/**
 * Filter out constructor, accessor, and utility functions.
 * Keep functions that look like "actions" (i.e., doing something meaningful).
 */
function filterCandidateActions(actions: SdkActionDraft[]): SdkActionDraft[] {
  return actions.filter((a) => {
    const name = a.name;

    // Exclude constructors / factory methods
    if (/^[Nn]ew[A-Z]/.test(name) && a.returnType) return false;

    // Exclude common non-action patterns
    if (/^(?:With|Set|Get|Is|Has|String|Error|Close|Init|Setup|Configure|Validate|Dispose|Destroy)$/.test(name)) {
      return false;
    }
    // "WithXxx" / "SetXxx" chainable methods → usually config, not action
    if (/^(?:With|Set)[A-Z]/.test(name) && !a.params.length) return false;

    // "GetXxx" with no params is usually an accessor
    if (/^Get[A-Z]/.test(name) && a.params.length === 0) return false;

    // Methods returning self/builder pattern
    if (a.receiver && a.returnType?.includes(a.receiver)) return false;

    // Python: methods with only 'self' param that return a simple value → likely a property/getter
    // (filter already has @property check, but this catches unlabeled ones)
    if (a.params.length === 0 && a.receiver && !a.description) {
      // Single-word method name matching a field pattern
      if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(name) && !a.returnType) return false;
    }

    return true;
  });
}

/**
 * Deduplicate actions by (name + receiver). When a sync and async version exist,
 * prefer the sync one (shorter filePath without "_async" / "async_").
 */
function deduplicateActions(actions: SdkActionDraft[]): SdkActionDraft[] {
  const seen = new Map<string, SdkActionDraft>();
  for (const action of actions) {
    const key = `${action.receiver ?? ''}::${action.name}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, action);
    } else {
      // Prefer non-async version
      const existIsAsync = /async/i.test(path.basename(existing.filePath));
      const curIsAsync = /async/i.test(path.basename(action.filePath));
      if (existIsAsync && !curIsAsync) {
        seen.set(key, action);
      }
    }
  }
  return Array.from(seen.values());
}

// ── Shared helpers ────────────────────────────────────────────────────

/**
 * Split parameter string on commas, respecting angle brackets, parens, etc.
 */
function smartSplitParams(paramsStr: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of paramsStr) {
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth--;

    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current);
  return result;
}

// ── Layer 1: Static structure extraction ──────────────────────────────

/**
 * Extract a structural snapshot from SDK source files.
 * This is the "first layer" — produces raw facts for AI analysis.
 * Works for all supported languages but especially important for Python
 * where pip package name ≠ import path.
 */
export async function extractStructureSnapshot(
  detection: SdkDetection,
): Promise<SdkStructureSnapshot> {
  const extractor = STRUCTURE_EXTRACTORS[detection.language];
  return extractor(detection);
}

const STRUCTURE_EXTRACTORS: Record<
  SdkLanguage,
  (detection: SdkDetection) => Promise<SdkStructureSnapshot>
> = {
  python: extractPythonStructure,
  go: extractGenericStructure,
  rust: extractGenericStructure,
  typescript: extractGenericStructure,
};

/**
 * Python-specific structure extraction.
 * Analyzes __init__.py locations, class hierarchies, models.py presence, etc.
 */
async function extractPythonStructure(detection: SdkDetection): Promise<SdkStructureSnapshot> {
  const snapshot: SdkStructureSnapshot = {
    language: 'python',
    packageName: detection.moduleName,
    classes: [],
    standaloneFunctions: [],
    notableFiles: [],
    fileTree: [],
  };

  // Build file tree (relative to rootDir)
  for (const f of detection.entryFiles) {
    snapshot.fileTree.push(path.relative(detection.rootDir, f));
  }

  // Find top-level importable module by scanning for __init__.py
  const initFiles = detection.entryFiles.filter((f) => f.endsWith('__init__.py'));
  if (initFiles.length > 0) {
    // Sort by depth (shallowest first)
    initFiles.sort((a, b) => a.split('/').length - b.split('/').length);
    // The shallowest __init__.py's parent directory is the top-level module
    const topLevelDir = path.dirname(initFiles[0]);
    snapshot.topLevelModule = path.basename(topLevelDir);
  }

  // Identify notable files
  const notablePatterns = ['models.py', 'types.py', 'schemas.py', 'client.py', 'credential.py', 'auth.py'];
  for (const f of detection.entryFiles) {
    const base = path.basename(f);
    if (notablePatterns.includes(base)) {
      snapshot.notableFiles.push(path.relative(detection.rootDir, f));
    }
  }

  // Extract class and function info from each file
  for (const filePath of detection.entryFiles) {
    const baseName = path.basename(filePath, '.py');
    // Skip model/type files for class extraction (but keep them in notableFiles)
    const content = await readFile(filePath, 'utf8');

    if (isPythonModelFile(content, baseName)) {
      continue;
    }

    const relativePath = path.relative(detection.rootDir, filePath);

    // Extract classes with full detail
    extractPythonClassStructure(content, relativePath, snapshot);

    // Extract standalone functions
    extractPythonStandaloneFunctions(content, relativePath, snapshot);
  }

  return snapshot;
}

/**
 * Extract Python class structures: name, base classes, __init__ params, methods.
 */
function extractPythonClassStructure(
  content: string,
  filePath: string,
  snapshot: SdkStructureSnapshot,
): void {
  // Match: class ClassName(BaseClass1, BaseClass2):
  const classRegex = /^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm;
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(content)) !== null) {
    const className = match[1];
    const basesStr = match[2] ?? '';
    const baseClasses = basesStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Skip private classes
    if (className.startsWith('_')) continue;

    const classStartIdx = match.index;

    // Find the class body — everything indented after the class: line until next dedent
    const afterClass = content.slice(classStartIdx + match[0].length);
    const classBody = extractPythonIndentedBlock(afterClass);

    // Extract __init__ params
    const initMatch = classBody.match(/def\s+__init__\s*\(([^)]*)\)/);
    const initParams = initMatch ? parsePythonParams(initMatch[1]) : [];

    // Extract methods (non-private, non-dunder)
    const methods: SdkStructureSnapshot['classes'][0]['methods'] = [];
    const methodRegex = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?:/g;
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodRegex.exec(classBody)) !== null) {
      const methodName = methodMatch[1];
      if (methodName.startsWith('_')) continue;

      const params = parsePythonParams(methodMatch[2]);
      const returnType = methodMatch[3]?.trim();

      // Extract docstring
      const afterMethod = classBody.slice(methodMatch.index + methodMatch[0].length);
      const docstring = extractPythonDocstring(afterMethod);

      methods.push({ name: methodName, params, returnType, docstring });
    }

    snapshot.classes.push({
      name: className,
      filePath,
      baseClasses,
      initParams,
      methods,
    });
  }
}

/**
 * Extract standalone (module-level) functions from Python source.
 */
function extractPythonStandaloneFunctions(
  content: string,
  filePath: string,
  snapshot: SdkStructureSnapshot,
): void {
  const funcRegex = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?:/gm;
  let match: RegExpExecArray | null;

  while ((match = funcRegex.exec(content)) !== null) {
    const funcName = match[1];
    if (funcName.startsWith('_')) continue;

    // Check this is truly at module level (no indentation)
    const lineStart = content.lastIndexOf('\n', match.index) + 1;
    const indent = match.index - lineStart;
    if (indent > 0) continue; // Inside a class or nested block

    const params = parsePythonParams(match[2]);
    const returnType = match[3]?.trim();

    const afterFunc = content.slice(match.index + match[0].length);
    const docstring = extractPythonDocstring(afterFunc);

    snapshot.standaloneFunctions.push({ name: funcName, filePath, params, returnType, docstring });
  }
}

/**
 * Extract a Python indented block after a colon-terminated line.
 * Returns the text of the block (including nested indentation).
 */
function extractPythonIndentedBlock(afterColon: string): string {
  const lines = afterColon.split('\n');
  const result: string[] = [];
  let blockIndent: number | null = null;

  for (const line of lines) {
    // Skip empty lines at the start
    if (blockIndent === null) {
      if (!line.trim()) {
        result.push(line);
        continue;
      }
      // First non-empty line determines the block indent
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent === 0) break; // Not indented → not part of block
      blockIndent = lineIndent;
      result.push(line);
      continue;
    }

    // Empty lines are part of the block
    if (!line.trim()) {
      result.push(line);
      continue;
    }

    // Check if still in block
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < blockIndent) break; // Dedented → block ended
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Generic structure extraction for Go/Rust/TypeScript.
 * Less critical than Python since import paths usually match package names.
 * Reuses existing extractors and wraps results in SdkStructureSnapshot format.
 */
async function extractGenericStructure(detection: SdkDetection): Promise<SdkStructureSnapshot> {
  const snapshot: SdkStructureSnapshot = {
    language: detection.language,
    packageName: detection.moduleName,
    classes: [],
    standaloneFunctions: [],
    notableFiles: [],
    fileTree: [],
  };

  for (const f of detection.entryFiles) {
    snapshot.fileTree.push(path.relative(detection.rootDir, f));
  }

  // Use existing extractors to get actions, then reorganize
  const extractor = EXTRACTORS[detection.language];
  for (const filePath of detection.entryFiles) {
    const content = await readFile(filePath, 'utf8');
    const actions = extractor(content, filePath);
    const relativePath = path.relative(detection.rootDir, filePath);

    for (const action of actions) {
      if (action.receiver) {
        let cls = snapshot.classes.find((c) => c.name === action.receiver);
        if (!cls) {
          cls = { name: action.receiver!, filePath: relativePath, baseClasses: [], initParams: [], methods: [] };
          snapshot.classes.push(cls);
        }
        cls.methods.push({
          name: action.name,
          params: action.params,
          returnType: action.returnType,
          docstring: action.description,
        });
      } else {
        snapshot.standaloneFunctions.push({
          name: action.name,
          filePath: relativePath,
          params: action.params,
          returnType: action.returnType,
          docstring: action.description,
        });
      }
    }
  }

  return snapshot;
}

// ── Layer 2: AI-based call convention inference ───────────────────────

/**
 * Use the configured LLM to infer the SDK call convention from a structure snapshot.
 * Falls back to static heuristics if LLM is not available.
 */
export async function inferCallConvention(
  snapshot: SdkStructureSnapshot,
): Promise<SdkCallConvention> {
  // Try AI inference first
  const aiResult = await aiInferCallConvention(snapshot);
  if (aiResult) return aiResult;

  // Fallback to static heuristics
  return staticInferCallConvention(snapshot);
}

/**
 * AI-based inference: send the structure snapshot to the configured LLM
 * and ask it to produce a SdkCallConvention JSON.
 */
async function aiInferCallConvention(
  snapshot: SdkStructureSnapshot,
): Promise<SdkCallConvention | null> {
  let config;
  try {
    const { readClixConfig } = await import('./config-store');
    config = await readClixConfig();
  } catch {
    return null;
  }

  const apiKey = config.llm.apiKey
    ?? (config.llm.apiKeyEnvName ? process.env[config.llm.apiKeyEnvName]?.trim() : undefined);

  if (!apiKey || !config.llm.baseUrl) {
    return null;
  }

  const baseUrl = config.llm.baseUrl.replace(/\/+$/, '');
  const model = config.llm.model;

  // Build a concise summary of the snapshot for the prompt
  const summaryLines: string[] = [];
  summaryLines.push(`Language: ${snapshot.language}`);
  summaryLines.push(`Package name: ${snapshot.packageName ?? '(unknown)'}`);
  if (snapshot.topLevelModule) {
    summaryLines.push(`Top-level importable module: ${snapshot.topLevelModule}`);
  }
  summaryLines.push(`Notable files: ${snapshot.notableFiles.join(', ') || '(none)'}`);
  summaryLines.push('');

  // Summarize file tree (limit to 50 entries)
  summaryLines.push('File tree (relative):');
  for (const f of snapshot.fileTree.slice(0, 50)) {
    summaryLines.push(`  ${f}`);
  }
  if (snapshot.fileTree.length > 50) {
    summaryLines.push(`  ... and ${snapshot.fileTree.length - 50} more files`);
  }
  summaryLines.push('');

  // Summarize classes
  for (const cls of snapshot.classes.slice(0, 10)) {
    summaryLines.push(`Class: ${cls.name} (in ${cls.filePath})`);
    if (cls.baseClasses.length > 0) {
      summaryLines.push(`  Inherits: ${cls.baseClasses.join(', ')}`);
    }
    if (cls.initParams.length > 0) {
      summaryLines.push(`  __init__ params: ${cls.initParams.map((p) => `${p.name}${p.rawType ? `: ${p.rawType}` : ''}`).join(', ')}`);
    }
    const methodNames = cls.methods.slice(0, 20).map((m) => {
      const paramInfo = m.params.map((p) => p.name).join(', ');
      return `${m.name}(${paramInfo})`;
    });
    summaryLines.push(`  Methods (${cls.methods.length} total): ${methodNames.join(', ')}`);
    if (cls.methods.length > 20) {
      summaryLines.push(`  ... and ${cls.methods.length - 20} more methods`);
    }
    summaryLines.push('');
  }

  // Summarize standalone functions
  if (snapshot.standaloneFunctions.length > 0) {
    summaryLines.push('Standalone functions:');
    for (const fn of snapshot.standaloneFunctions.slice(0, 20)) {
      summaryLines.push(`  ${fn.name}(${fn.params.map((p) => p.name).join(', ')})`);
    }
    summaryLines.push('');
  }

  const systemPrompt = `You are a Python/Go/Rust/TypeScript SDK expert. Given a structural summary of an SDK package, determine how it should be called programmatically.

Return a valid JSON object matching this schema:
{
  "kind": "simple-function" | "simple-class" | "cloud-sdk" | "custom",
  "importStatements": ["import ...", ...],
  "auth": {
    "envVars": { "ENV_VAR_NAME": "description", ... },
    "codeTemplate": "code to construct auth object using {{env_var}} placeholders",
    "outputVar": "variable_name"
  } | null,
  "setupSteps": [
    {
      "kind": "instantiate",
      "label": "description",
      "codeTemplate": "code with {{placeholders}}",
      "outputs": ["var_name"],
      "inputs": ["var_from_earlier_step"]
    }
  ],
  "callPattern": {
    "style": "single-request-object" | "kwargs" | "positional",
    "codeTemplate": "code template with {{client}}, {{action}}, {{request}}, {{args}}",
    "requestClassSuffix": "Request" (only for single-request-object),
    "requestPopulateTemplate": "code to populate the request object" (only for single-request-object)
  },
  "extraCliFlags": [
    { "name": "region", "description": "Cloud region", "required": true, "envVar": "XX_REGION", "defaultValue": null }
  ]
}

Rules:
- "simple-function": SDK is just a collection of importable functions (e.g. requests.get())
- "simple-class": SDK has a client class that needs instantiation but no special auth (e.g. redis.Redis())
- "cloud-sdk": SDK requires authentication credential + client instantiation + request objects (e.g. Tencent Cloud, AWS boto3)
- "custom": anything that doesn't fit the above — provide best-effort templates
- For importStatements, use the ACTUAL Python import paths (not pip package names). Derive from file tree.
- For auth, identify environment variables from __init__ param names (credential, api_key, secret_id, etc.)
- Only return the JSON object, no markdown fences, no explanation.
- If auth is not needed, set "auth" to null.`;

  const userPrompt = summaryLines.join('\n');

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const jsonStr = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    return parseAiCallConvention(parsed);
  } catch {
    return null;
  }
}

/**
 * Parse and validate AI-returned call convention JSON into a typed SdkCallConvention.
 */
function parseAiCallConvention(raw: Record<string, unknown>): SdkCallConvention | null {
  const validKinds = ['simple-function', 'simple-class', 'cloud-sdk', 'custom'] as const;
  const kind = validKinds.includes(raw.kind as typeof validKinds[number])
    ? (raw.kind as SdkCallConvention['kind'])
    : 'custom';

  const importStatements = Array.isArray(raw.importStatements)
    ? (raw.importStatements as string[]).filter((s) => typeof s === 'string')
    : [];

  let auth: SdkAuthConfig | undefined;
  if (raw.auth && typeof raw.auth === 'object' && !Array.isArray(raw.auth)) {
    const authRaw = raw.auth as Record<string, unknown>;
    if (typeof authRaw.codeTemplate === 'string' && typeof authRaw.outputVar === 'string') {
      auth = {
        envVars: (typeof authRaw.envVars === 'object' && authRaw.envVars !== null)
          ? authRaw.envVars as Record<string, string>
          : {},
        codeTemplate: authRaw.codeTemplate,
        outputVar: authRaw.outputVar,
      };
    }
  }

  const setupSteps: SdkCallStep[] = [];
  if (Array.isArray(raw.setupSteps)) {
    for (const step of raw.setupSteps as Array<Record<string, unknown>>) {
      if (typeof step.codeTemplate === 'string') {
        setupSteps.push({
          kind: (['import', 'instantiate', 'construct_request', 'call'].includes(step.kind as string)
            ? step.kind : 'instantiate') as SdkCallStep['kind'],
          label: typeof step.label === 'string' ? step.label : '',
          codeTemplate: step.codeTemplate,
          outputs: Array.isArray(step.outputs) ? step.outputs as string[] : undefined,
          inputs: Array.isArray(step.inputs) ? step.inputs as string[] : undefined,
        });
      }
    }
  }

  let callPattern: SdkCallConvention['callPattern'];
  if (raw.callPattern && typeof raw.callPattern === 'object') {
    const cp = raw.callPattern as Record<string, unknown>;
    const validStyles = ['single-request-object', 'kwargs', 'positional'] as const;
    callPattern = {
      style: validStyles.includes(cp.style as typeof validStyles[number])
        ? (cp.style as typeof validStyles[number])
        : 'kwargs',
      codeTemplate: typeof cp.codeTemplate === 'string' ? cp.codeTemplate : '{{client}}.{{action}}({{args}})',
      requestClassSuffix: typeof cp.requestClassSuffix === 'string' ? cp.requestClassSuffix : undefined,
      requestPopulateTemplate: typeof cp.requestPopulateTemplate === 'string' ? cp.requestPopulateTemplate : undefined,
    };
  } else {
    callPattern = { style: 'kwargs', codeTemplate: '{{client}}.{{action}}({{args}})' };
  }

  const extraCliFlags: SdkCallConvention['extraCliFlags'] = [];
  if (Array.isArray(raw.extraCliFlags)) {
    for (const flag of raw.extraCliFlags as Array<Record<string, unknown>>) {
      if (typeof flag.name === 'string') {
        extraCliFlags.push({
          name: flag.name,
          description: typeof flag.description === 'string' ? flag.description : '',
          required: Boolean(flag.required),
          envVar: typeof flag.envVar === 'string' ? flag.envVar : undefined,
          defaultValue: typeof flag.defaultValue === 'string' ? flag.defaultValue : undefined,
        });
      }
    }
  }

  return {
    kind,
    importStatements,
    auth,
    setupSteps,
    callPattern,
    extraCliFlags: extraCliFlags.length > 0 ? extraCliFlags : undefined,
    confidence: 0.8,
    inferredBy: 'ai',
  };
}

/**
 * Static heuristic-based inference — used as fallback when AI is unavailable.
 * Examines the structure snapshot and applies pattern matching.
 */
function staticInferCallConvention(snapshot: SdkStructureSnapshot): SdkCallConvention {
  // Check for cloud SDK pattern: client class inheriting from AbstractClient/BaseClient
  const cloudClientPatterns = ['AbstractClient', 'BaseClient', 'ServiceClient', 'AcsClient'];
  const cloudClient = snapshot.classes.find((cls) =>
    cls.baseClasses.some((b) => cloudClientPatterns.some((p) => b.includes(p))),
  );

  if (cloudClient && snapshot.language === 'python') {
    return inferPythonCloudSdkConvention(snapshot, cloudClient);
  }

  // Check for simple-class pattern: class with __init__ and public methods
  const clientClasses = snapshot.classes.filter((cls) =>
    cls.initParams.length > 0 && cls.methods.length > 0,
  );

  if (clientClasses.length > 0 && snapshot.standaloneFunctions.length === 0) {
    const primaryClient = clientClasses[0];
    return inferSimpleClassConvention(snapshot, primaryClient);
  }

  // Default: simple-function pattern
  return inferSimpleFunctionConvention(snapshot);
}

function inferPythonCloudSdkConvention(
  snapshot: SdkStructureSnapshot,
  clientClass: SdkStructureSnapshot['classes'][0],
): SdkCallConvention {
  // Derive import path from file path
  const filePath = clientClass.filePath.replace(/\.py$/, '').replace(/\//g, '.');
  const topModule = snapshot.topLevelModule ?? snapshot.packageName ?? 'sdk';

  // Check if there's a models.py alongside
  const clientDir = path.dirname(clientClass.filePath);
  const hasModels = snapshot.notableFiles.some((f) =>
    f.startsWith(clientDir) && path.basename(f) === 'models.py',
  );
  const modelsImport = hasModels ? `${clientDir.replace(/\//g, '.')}.models` : undefined;

  // Detect credential pattern from __init__ params
  const hasCredential = clientClass.initParams.some((p) =>
    /credential|cred/i.test(p.name),
  );
  const hasRegion = clientClass.initParams.some((p) =>
    /region/i.test(p.name),
  );

  // Check if methods take a single request param
  const singleRequestMethods = clientClass.methods.filter((m) =>
    m.params.length === 1 && /request/i.test(m.params[0].name),
  );
  const usesRequestObjects = singleRequestMethods.length > clientClass.methods.length * 0.5;

  const importStatements: string[] = [];
  if (hasCredential) {
    importStatements.push(`from ${topModule}.common import credential`);
  }
  importStatements.push(`from ${filePath.replace(/\.[^.]+$/, '')} import ${path.basename(clientClass.filePath, '.py')}`);
  if (modelsImport) {
    importStatements.push(`from ${modelsImport} import *`);
  }

  const auth: SdkAuthConfig | undefined = hasCredential
    ? {
        envVars: {
          [`${topModule.toUpperCase()}_SECRET_ID`]: 'API Secret ID',
          [`${topModule.toUpperCase()}_SECRET_KEY`]: 'API Secret Key',
        },
        codeTemplate: `credential.Credential(os.environ["{{${topModule.toUpperCase()}_SECRET_ID}}"], os.environ["{{${topModule.toUpperCase()}_SECRET_KEY}}"])`,
        outputVar: 'cred',
      }
    : undefined;

  const setupSteps: SdkCallStep[] = [];
  const clientInitArgs = ['cred'];
  if (hasRegion) clientInitArgs.push('region');

  setupSteps.push({
    kind: 'instantiate',
    label: `Create ${clientClass.name} instance`,
    codeTemplate: `client = ${clientClass.name}(${clientInitArgs.join(', ')})`,
    outputs: ['client'],
    inputs: hasCredential ? ['cred'] : [],
  });

  const callPattern: SdkCallConvention['callPattern'] = usesRequestObjects
    ? {
        style: 'single-request-object',
        codeTemplate: 'client.{{action}}(req)',
        requestClassSuffix: 'Request',
        requestPopulateTemplate: 'req = models.{{action}}Request()\nreq.from_json_string(json.dumps({{args}}))',
      }
    : {
        style: 'kwargs',
        codeTemplate: 'client.{{action}}({{args}})',
      };

  const extraCliFlags: SdkCallConvention['extraCliFlags'] = [];
  if (hasRegion) {
    extraCliFlags.push({
      name: 'region',
      description: 'Cloud region',
      required: true,
      envVar: `${topModule.toUpperCase()}_REGION`,
    });
  }

  return {
    kind: 'cloud-sdk',
    importStatements,
    auth,
    setupSteps,
    callPattern,
    extraCliFlags: extraCliFlags.length > 0 ? extraCliFlags : undefined,
    confidence: 0.6,
    inferredBy: 'static',
  };
}

function inferSimpleClassConvention(
  snapshot: SdkStructureSnapshot,
  clientClass: SdkStructureSnapshot['classes'][0],
): SdkCallConvention {
  const moduleName = snapshot.topLevelModule ?? snapshot.packageName ?? 'sdk';
  const importPath = clientClass.filePath.replace(/\.py$/, '').replace(/\//g, '.');

  return {
    kind: 'simple-class',
    importStatements: [`import ${moduleName}`],
    setupSteps: [{
      kind: 'instantiate',
      label: `Create ${clientClass.name} instance`,
      codeTemplate: `client = ${moduleName}.${clientClass.name}(${clientClass.initParams.map((p) => p.name).join(', ')})`,
      outputs: ['client'],
    }],
    callPattern: {
      style: 'kwargs',
      codeTemplate: 'client.{{action}}({{args}})',
    },
    confidence: 0.5,
    inferredBy: 'static',
  };
}

function inferSimpleFunctionConvention(snapshot: SdkStructureSnapshot): SdkCallConvention {
  const moduleName = snapshot.topLevelModule ?? snapshot.packageName ?? 'sdk';

  return {
    kind: 'simple-function',
    importStatements: [`import ${moduleName}`],
    setupSteps: [],
    callPattern: {
      style: 'kwargs',
      codeTemplate: `${moduleName}.{{action}}({{args}})`,
    },
    confidence: 0.5,
    inferredBy: 'static',
  };
}
