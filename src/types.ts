export type ImportMode = 'strict' | 'hybrid' | 'ai';
export type SourceType = 'file' | 'url' | 'stdin';
export type ContentType = 'markdown' | 'html' | 'pdf' | 'text';
export type ContentTypeOption = ContentType | 'auto';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
export type SdkLanguage = 'go' | 'rust' | 'typescript' | 'python';

/**
 * Language aliases accepted in `--from lang:spec` syntax.
 * Maps user-facing short names to canonical SdkLanguage values.
 */
export const SDK_LANGUAGE_ALIASES: Record<string, SdkLanguage> = {
  go: 'go',
  rust: 'rust',
  rs: 'rust',
  typescript: 'typescript',
  ts: 'typescript',
  javascript: 'typescript', // treat JS as TS internally
  js: 'typescript',
  python: 'python',
  py: 'python',
};

/**
 * Parsed result from `--from lang:spec` syntax.
 *
 * Examples:
 *   go:./image-sdk/          → { language: 'go', spec: './image-sdk/', isRemote: false }
 *   python:requests==1.1.1   → { language: 'python', spec: 'requests==1.1.1', isRemote: true }
 *   js:sharp@latest          → { language: 'typescript', spec: 'sharp@latest', isRemote: true }
 *   go:github.com/foo/bar    → { language: 'go', spec: 'github.com/foo/bar', isRemote: true }
 *   ./docs/api.md            → null (not SDK format)
 */
export interface SdkSourceSpec {
  language: SdkLanguage;
  /** The part after `lang:` — can be a local path or a package specifier */
  spec: string;
  /** True when spec looks like a remote package (not a local path) */
  isRemote: boolean;
}

/**
 * Parse the `--from` value. If it matches `lang:spec`, returns SdkSourceSpec.
 * Otherwise returns null (the value is a plain path/URL, handled by existing flow).
 */
export function parseSdkSource(from: string): SdkSourceSpec | null {
  // Match lang:spec — the colon must come after a short alphabetic prefix
  // Exclude URLs like https://... and Windows paths like C:\...
  const match = from.match(/^([a-zA-Z]{1,12}):(.+)$/);
  if (!match) return null;

  const prefix = match[1].toLowerCase();
  const spec = match[2];

  // Exclude URL schemes
  if (['http', 'https', 'ftp', 'file'].includes(prefix)) return null;

  const language = SDK_LANGUAGE_ALIASES[prefix];
  if (!language) return null;

  // Determine if spec is a local path or remote package
  const isRemote = !spec.startsWith('./') && !spec.startsWith('/') && !spec.startsWith('../') && !spec.startsWith('~');

  return { language, spec, isRemote };
}
export type DraftStatus = 'draft' | 'approved' | 'rejected';
export type ReviewStatus = 'needs_attention' | 'ready' | 'approved' | 'rejected';

export interface SectionBlock {
  heading?: string;
  level?: number;
  content: string;
}

export interface CodeBlock {
  language?: string;
  content: string;
}

export interface TableBlock {
  header: string[];
  rows: string[][];
  raw: string;
}

export interface NormalizedDocument {
  title?: string;
  sourceLabel: string;
  sourceType: SourceType;
  contentType: ContentType;
  rawContent: string;
  rawText: string;
  sections: SectionBlock[];
  codeBlocks: CodeBlock[];
  tables: TableBlock[];
  metadata: Record<string, string>;
}

export interface EvidenceItem {
  kind: string;
  snippet: string;
}

export interface ParamSpec {
  name: string;
  type: ParamType;
  required: boolean;
  description?: string;
  enum?: string[];
  location: 'query' | 'path' | 'header' | 'body';
}

export interface ExampleSpec {
  kind: 'request' | 'response';
  content: unknown;
  source: 'rule' | 'ai';
}

export interface ExtractedActionDraft {
  provider: string;
  service: string;
  action: string;
  description?: string;
  method?: HttpMethod;
  host?: string;
  path?: string;
  params: ParamSpec[];
  authHints: string[];
  examples: ExampleSpec[];
  confidence: number;
  source: 'rule' | 'ai' | 'merged';
  evidence: EvidenceItem[];
  input: {
    mode: ImportMode;
    sourceType: SourceType;
    sourceLabel: string;
    contentType: ContentType;
    importedAt: string;
  };
  status: DraftStatus;
  rejectionReason?: string;
  approvedAt?: string;
}

export interface ReviewIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  field?: string;
}

export interface ReviewResult {
  provider: string;
  service: string;
  action: string;
  status: ReviewStatus;
  blockingIssueCount: number;
  warningCount: number;
  issues: ReviewIssue[];
  summary: string;
  generatedAt: string;
}

export interface CanonicalSpec {
  provider: {
    name: string;
    version: string;
  };
  services: Array<{
    name: string;
    host?: string;
    actions: Array<{
      name: string;
      method?: HttpMethod;
      path?: string;
      description?: string;
      params: ParamSpec[];
      examples: ExampleSpec[];
    }>;
  }>;
  auth: Array<{
    type: string;
    hints: string[];
  }>;
  sourceMeta: {
    mode: ImportMode;
    sourceType: SourceType;
    sourceLabel: string;
    contentType: ContentType;
    importedAt: string;
    approvedAt?: string;
    confidence: number;
    evidence: EvidenceItem[];
  };
}

export interface ImportDocInput {
  source?: string;
  stdin?: boolean;
  provider: string;
  service?: string;
  mode?: ImportMode;
  sourceType?: SourceType;
  contentType?: ContentTypeOption;
  entry?: string;
  outputDir?: string;
  workspaceRoot?: string;
}

export interface ImportDocumentResult {
  draft: ExtractedActionDraft;
  review: ReviewResult;
  draftFilePath: string;
  reviewFilePath: string;
}

export interface ArtifactLookupInput {
  provider: string;
  service: string;
  action: string;
  outputDir?: string;
  workspaceRoot?: string;
}

export interface ApproveImportInput extends ArtifactLookupInput {
  force?: boolean;
}

export interface RejectImportInput extends ArtifactLookupInput {
  reason?: string;
}

export interface ImportListInput {
  status?: DraftStatus | 'all';
  provider?: string;
  service?: string;
  outputDir?: string;
  workspaceRoot?: string;
}

export interface ImportListItem {
  provider: string;
  service: string;
  action: string;
  status: DraftStatus;
  reviewStatus: ReviewStatus;
  confidence: number;
  draftFilePath: string;
  reviewFilePath: string;
}
