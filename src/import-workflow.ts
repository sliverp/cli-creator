import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type {
  ApproveImportInput,
  CanonicalSpec,
  ContentType,
  DraftStatus,
  ExampleSpec,
  ExtractedActionDraft,
  HttpMethod,
  ImportDocInput,
  ImportDocumentResult,
  ImportListInput,
  ImportListItem,
  NormalizedDocument,
  ParamSpec,
  RejectImportInput,
  ReviewIssue,
  ReviewResult,
  SourceType,
  TableBlock,
} from './types';
import {
  collectFiles,
  decodeHtmlEntities,
  fileExists,
  inferValueType,
  mergeParams,
  normalizeNewlines,
  readJson,
  readStdinText,
  sanitizePathSegment,
  safeJsonParse,
  stripHtmlTags,
  writeJson,
} from './utils';

const IMPORT_DOC_SCHEMA = z.object({
  source: z.string().optional(),
  stdin: z.boolean().optional().default(false),
  provider: z.string().min(1),
  service: z.string().optional(),
  mode: z.enum(['strict', 'hybrid', 'ai']).optional().default('ai'),
  sourceType: z.enum(['file', 'url', 'stdin']).optional(),
  contentType: z.enum(['auto', 'markdown', 'html', 'pdf', 'text']).optional().default('auto'),
  entry: z.string().optional(),
  outputDir: z.string().optional().default('.spec-workspace'),
  workspaceRoot: z.string().optional().default(process.cwd()),
});

const ARTIFACT_LOOKUP_SCHEMA = z.object({
  provider: z.string().min(1),
  service: z.string().min(1),
  action: z.string().min(1),
  outputDir: z.string().optional().default('.spec-workspace'),
  workspaceRoot: z.string().optional().default(process.cwd()),
});

const LIST_IMPORTS_SCHEMA = z.object({
  status: z.enum(['draft', 'approved', 'rejected', 'all']).optional().default('all'),
  provider: z.string().optional(),
  service: z.string().optional(),
  outputDir: z.string().optional().default('.spec-workspace'),
  workspaceRoot: z.string().optional().default(process.cwd()),
});

const HTTP_REQUEST_PATTERN = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s+HTTP\/[\d.]+/im;
const HOST_PATTERN = /^Host:\s*([^\s]+)$/im;
const ACTION_PATTERN = /^X-[A-Za-z-]*Action:\s*([A-Za-z0-9_]+)$/im;
const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;

type LoadedSource = {
  sourceLabel: string;
  sourceType: SourceType;
  contentType: ContentType;
  rawContent: string;
  metadata: Record<string, string>;
};

type ArtifactPaths = {
  draftFilePath: string;
  reviewFilePath: string;
};

export async function importDocument(input: ImportDocInput): Promise<ImportDocumentResult> {
  const options = IMPORT_DOC_SCHEMA.parse(input);
  const source = await loadSource(options);
  const normalized = await normalizeDocument(source, options.entry);
  const draft = await extractDraft({
    document: normalized,
    provider: options.provider,
    service: options.service,
    mode: options.mode,
  });

  return saveImportArtifacts({
    draft,
    outputDir: options.outputDir,
    workspaceRoot: options.workspaceRoot,
  });
}

export async function saveImportArtifacts(input: {
  draft: ExtractedActionDraft;
  outputDir?: string;
  workspaceRoot?: string;
}): Promise<ImportDocumentResult> {
  const options = z.object({
    draft: z.custom<ExtractedActionDraft>(),
    outputDir: z.string().optional().default('.spec-workspace'),
    workspaceRoot: z.string().optional().default(process.cwd()),
  }).parse(input);
  const review = buildReview(options.draft);
  const paths = resolveArtifactPaths({
    workspaceRoot: options.workspaceRoot,
    outputDir: options.outputDir,
    provider: options.draft.provider,
    service: options.draft.service,
    action: options.draft.action,
  });

  await writeJson(paths.draftFilePath, options.draft);
  await writeJson(paths.reviewFilePath, review);

  return {
    draft: options.draft,
    review,
    draftFilePath: paths.draftFilePath,
    reviewFilePath: paths.reviewFilePath,
  };
}

export async function loadImportArtifacts(input: ApproveImportInput): Promise<{
  draft: ExtractedActionDraft;
  review: ReviewResult;
  paths: ArtifactPaths;
}> {
  const options = ARTIFACT_LOOKUP_SCHEMA.parse(input);
  const paths = resolveArtifactPaths(options);

  if (!(await fileExists(paths.draftFilePath))) {
    throw new Error(`未找到 draft：${paths.draftFilePath}`);
  }
  if (!(await fileExists(paths.reviewFilePath))) {
    throw new Error(`未找到 review：${paths.reviewFilePath}`);
  }

  const draft = await readJson<ExtractedActionDraft>(paths.draftFilePath);
  const review = await readJson<ReviewResult>(paths.reviewFilePath);

  return { draft, review, paths };
}

export async function approveImport(input: ApproveImportInput): Promise<{
  draft: ExtractedActionDraft;
  review: ReviewResult;
  spec: CanonicalSpec;
  specFilePath: string;
}> {
  const options = ARTIFACT_LOOKUP_SCHEMA.extend({
    force: z.boolean().optional().default(false),
  }).parse(input);
  const { draft, review, paths } = await loadImportArtifacts(options);

  if (review.blockingIssueCount > 0 && !options.force) {
    throw new Error(`存在 ${review.blockingIssueCount} 个 blocking 问题，请先修复或使用 --force。`);
  }

  const approvedAt = new Date().toISOString();
  draft.status = 'approved';
  draft.approvedAt = approvedAt;
  delete draft.rejectionReason;

  review.status = 'approved';
  review.summary = '已批准，可进入后续 spec/build 流程。';
  review.generatedAt = approvedAt;

  await writeJson(paths.draftFilePath, draft);
  await writeJson(paths.reviewFilePath, review);

  const spec = toCanonicalSpec(draft);
  const specFilePath = path.join(
    path.resolve(options.workspaceRoot),
    'specs',
    sanitizePathSegment(draft.provider),
    sanitizePathSegment(draft.service),
    `${sanitizePathSegment(draft.action)}.spec.json`,
  );
  await writeJson(specFilePath, spec);

  return { draft, review, spec, specFilePath };
}

export async function rejectImport(input: RejectImportInput): Promise<{
  draft: ExtractedActionDraft;
  review: ReviewResult;
}> {
  const options = ARTIFACT_LOOKUP_SCHEMA.extend({
    reason: z.string().optional().default('manually rejected'),
  }).parse(input);
  const { draft, review, paths } = await loadImportArtifacts(options);

  draft.status = 'rejected';
  draft.rejectionReason = options.reason;

  review.status = 'rejected';
  review.summary = `已拒绝：${options.reason}`;
  review.generatedAt = new Date().toISOString();

  await writeJson(paths.draftFilePath, draft);
  await writeJson(paths.reviewFilePath, review);

  return { draft, review };
}

export async function listImports(input: ImportListInput = {}): Promise<ImportListItem[]> {
  const options = LIST_IMPORTS_SCHEMA.parse(input);
  const importRoot = path.join(path.resolve(options.workspaceRoot), options.outputDir, 'imports');
  const draftFiles = await collectFiles(importRoot, (filePath) => filePath.endsWith('.draft.json'));

  const items = await Promise.all(
    draftFiles.map(async (draftFilePath) => {
      const reviewFilePath = draftFilePath.replace(/\.draft\.json$/, '.review.json');
      const draft = await readJson<ExtractedActionDraft>(draftFilePath);
      const review = (await fileExists(reviewFilePath))
        ? await readJson<ReviewResult>(reviewFilePath)
        : buildReview(draft);

      return {
        provider: draft.provider,
        service: draft.service,
        action: draft.action,
        status: draft.status,
        reviewStatus: review.status,
        confidence: draft.confidence,
        draftFilePath,
        reviewFilePath,
      } satisfies ImportListItem;
    }),
  );

  return items
    .filter((item) => (options.status === 'all' ? true : item.status === options.status))
    .filter((item) => (options.provider ? item.provider === options.provider : true))
    .filter((item) => (options.service ? item.service === options.service : true))
    .sort((left, right) => `${left.provider}/${left.service}/${left.action}`.localeCompare(`${right.provider}/${right.service}/${right.action}`));
}

async function loadSource(input: z.infer<typeof IMPORT_DOC_SCHEMA>): Promise<LoadedSource> {
  const sourceType = resolveSourceType(input);
  const sourceLabel = sourceType === 'stdin' ? 'stdin' : input.source!;

  if (sourceType === 'stdin') {
    const rawContent = await readStdinText();
    return {
      sourceLabel,
      sourceType,
      contentType: resolveContentType({
        sourceLabel,
        requestedContentType: input.contentType,
      }),
      rawContent,
      metadata: {},
    };
  }

  if (sourceType === 'file') {
    const absolutePath = path.resolve(input.source!);
    const contentType = resolveContentType({
      sourceLabel: absolutePath,
      requestedContentType: input.contentType,
    });

    if (contentType === 'pdf') {
      const buffer = await readFile(absolutePath);
      const rawContent = await parsePdfBuffer(buffer);
      return {
        sourceLabel: absolutePath,
        sourceType,
        contentType,
        rawContent,
        metadata: {},
      };
    }

    const rawContent = await readFile(absolutePath, 'utf8');
    return {
      sourceLabel: absolutePath,
      sourceType,
      contentType,
      rawContent,
      metadata: {},
    };
  }

  const response = await fetch(input.source!);
  if (!response.ok) {
    throw new Error(`拉取 URL 失败：${response.status} ${response.statusText}`);
  }

  const responseContentType = response.headers.get('content-type') ?? '';
  const contentType = resolveContentType({
    sourceLabel: input.source!,
    requestedContentType: input.contentType,
    responseContentType,
  });

  if (contentType === 'pdf') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      sourceLabel: input.source!,
      sourceType,
      contentType,
      rawContent: await parsePdfBuffer(buffer),
      metadata: { responseContentType },
    };
  }

  return {
    sourceLabel: input.source!,
    sourceType,
    contentType,
    rawContent: await response.text(),
    metadata: { responseContentType },
  };
}

function resolveSourceType(input: z.infer<typeof IMPORT_DOC_SCHEMA>): SourceType {
  if (input.sourceType) {
    return input.sourceType;
  }
  if (input.stdin) {
    return 'stdin';
  }
  if (!input.source) {
    throw new Error('缺少 source，文件/URL 导入请传入路径，管道导入请使用 --stdin。');
  }
  if (/^https?:\/\//i.test(input.source)) {
    return 'url';
  }
  return 'file';
}

function resolveContentType(args: {
  sourceLabel: string;
  requestedContentType: z.infer<typeof IMPORT_DOC_SCHEMA>['contentType'];
  responseContentType?: string;
}): ContentType {
  if (args.requestedContentType && args.requestedContentType !== 'auto') {
    return args.requestedContentType;
  }

  const lowerSource = args.sourceLabel.toLowerCase();
  const lowerResponseType = (args.responseContentType ?? '').toLowerCase();

  if (lowerSource.endsWith('.md') || lowerSource.endsWith('.markdown')) {
    return 'markdown';
  }
  if (lowerSource.endsWith('.html') || lowerSource.endsWith('.htm') || lowerResponseType.includes('text/html')) {
    return 'html';
  }
  if (lowerSource.endsWith('.pdf') || lowerResponseType.includes('application/pdf')) {
    return 'pdf';
  }
  return 'text';
}

async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  const pdfParse = require('pdf-parse') as (input: Buffer) => Promise<{ text: string }>;
  const result = await pdfParse(buffer);
  return normalizeNewlines(result.text);
}

async function normalizeDocument(source: LoadedSource, entry?: string): Promise<NormalizedDocument> {
  const rawContent = normalizeNewlines(source.rawContent);

  switch (source.contentType) {
    case 'markdown':
      return applyEntryFilter(
        {
          title: extractFirstMarkdownHeading(rawContent),
          sourceLabel: source.sourceLabel,
          sourceType: source.sourceType,
          contentType: source.contentType,
          rawContent,
          rawText: rawContent,
          sections: extractTextSections(rawContent),
          codeBlocks: dedupeCodeBlocks([...extractMarkdownCodeBlocks(rawContent), ...extractLooseCodeBlocks(rawContent)]),
          tables: extractMarkdownTables(rawContent),
          metadata: source.metadata,
        },
        entry,
      );
    case 'html': {
      const titleMatch = rawContent.match(TITLE_PATTERN);
      const rawText = stripHtmlTags(rawContent);
      return applyEntryFilter(
        {
          title: titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]).trim() : undefined,
          sourceLabel: source.sourceLabel,
          sourceType: source.sourceType,
          contentType: source.contentType,
          rawContent,
          rawText,
          sections: extractTextSections(rawText),
          codeBlocks: dedupeCodeBlocks([...extractHtmlCodeBlocks(rawContent), ...extractLooseCodeBlocks(rawText)]),
          tables: extractHtmlTables(rawContent),
          metadata: source.metadata,
        },
        entry,
      );
    }
    case 'pdf':
    case 'text':
    default:
      return applyEntryFilter(
        {
          title: undefined,
          sourceLabel: source.sourceLabel,
          sourceType: source.sourceType,
          contentType: source.contentType,
          rawContent,
          rawText: rawContent,
          sections: extractTextSections(rawContent),
          codeBlocks: dedupeCodeBlocks(extractLooseCodeBlocks(rawContent)),
          tables: [],
          metadata: source.metadata,
        },
        entry,
      );
  }
}

function applyEntryFilter(document: NormalizedDocument, entry?: string): NormalizedDocument {
  if (!entry) {
    return document;
  }

  const marker = entry.replace(/^#+\s*/, '').trim().toLowerCase();
  if (!marker) {
    return document;
  }

  const index = document.rawText.toLowerCase().indexOf(marker);
  if (index < 0) {
    return document;
  }

  const filteredText = document.rawText.slice(index);
  return {
    ...document,
    rawText: filteredText,
    sections: extractTextSections(filteredText),
    codeBlocks: dedupeCodeBlocks(extractLooseCodeBlocks(filteredText).concat(document.codeBlocks)),
  };
}

function extractFirstMarkdownHeading(rawContent: string): string | undefined {
  const match = rawContent.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function extractTextSections(rawText: string): NormalizedDocument['sections'] {
  const lines = rawText.split('\n');
  const sections: NormalizedDocument['sections'] = [];
  let currentHeading: string | undefined;
  let currentLevel: number | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content || currentHeading) {
      sections.push({ heading: currentHeading, level: currentLevel, content });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      continue;
    }
    buffer.push(line);
  }

  flush();
  return sections.filter((section) => section.heading || section.content);
}

function extractMarkdownCodeBlocks(rawContent: string): NormalizedDocument['codeBlocks'] {
  const blocks: NormalizedDocument['codeBlocks'] = [];
  const pattern = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawContent))) {
    blocks.push({
      language: match[1]?.trim() || undefined,
      content: match[2].trim(),
    });
  }
  return blocks;
}

function extractLooseCodeBlocks(rawText: string): NormalizedDocument['codeBlocks'] {
  const blocks: NormalizedDocument['codeBlocks'] = [];

  const httpMatch = rawText.match(/((?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/[\d.]+[\s\S]*?)(?:\n\n|$)/im);
  if (httpMatch?.[1]) {
    blocks.push({ language: 'http', content: httpMatch[1].trim() });
  }

  for (const jsonBlock of extractJsonLikeBlocks(rawText)) {
    blocks.push({ language: 'json', content: jsonBlock });
  }

  return blocks;
}

function extractJsonLikeBlocks(rawText: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const candidate = rawText.slice(start, index + 1).trim();
          if (candidate.length >= 4 && safeJsonParse(candidate)) {
            blocks.push(candidate);
          }
          start = -1;
        }
      }
    }
  }

  return [...new Set(blocks)];
}

function extractMarkdownTables(rawContent: string): TableBlock[] {
  const lines = rawContent.split('\n');
  const tables: TableBlock[] = [];
  let group: string[] = [];

  const flush = () => {
    if (group.length >= 2 && group[1].includes('---')) {
      const header = splitTableLine(group[0]);
      const rows = group.slice(2).map(splitTableLine).filter((cells) => cells.length > 0);
      if (header.length > 0 && rows.length > 0) {
        tables.push({ header, rows, raw: group.join('\n') });
      }
    }
    group = [];
  };

  for (const line of lines) {
    if (line.includes('|')) {
      group.push(line);
    } else if (group.length) {
      flush();
    }
  }
  flush();

  return tables;
}

function splitTableLine(line: string): string[] {
  return line
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function extractHtmlCodeBlocks(rawContent: string): NormalizedDocument['codeBlocks'] {
  const blocks: NormalizedDocument['codeBlocks'] = [];
  const pattern = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawContent))) {
    blocks.push({
      language: guessCodeLanguage(match[1]),
      content: stripHtmlTags(match[1]),
    });
  }
  return blocks;
}

function extractHtmlTables(rawContent: string): TableBlock[] {
  const tables: TableBlock[] = [];
  const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tablePattern.exec(rawContent))) {
    const rows = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripHtmlTags(cell[1]).trim()),
    );
    if (rows.length >= 2) {
      tables.push({
        header: rows[0].filter(Boolean),
        rows: rows.slice(1).map((row) => row.filter(Boolean)).filter((row) => row.length > 0),
        raw: tableMatch[0],
      });
    }
  }

  return tables;
}

function guessCodeLanguage(value: string): string | undefined {
  const cleaned = stripHtmlTags(value).trim();
  if (cleaned.startsWith('{')) {
    return 'json';
  }
  if (HTTP_REQUEST_PATTERN.test(cleaned)) {
    return 'http';
  }
  return undefined;
}

function dedupeCodeBlocks(codeBlocks: NormalizedDocument['codeBlocks']): NormalizedDocument['codeBlocks'] {
  const seen = new Set<string>();
  return codeBlocks.filter((block) => {
    const key = `${block.language ?? 'unknown'}:${block.content}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function extractDraft(args: {
  document: NormalizedDocument;
  provider: string;
  service?: string;
  mode: 'strict' | 'hybrid' | 'ai';
}): Promise<ExtractedActionDraft> {
  const { document, provider, service, mode } = args;
  const text = document.rawText;
  const httpSource = findFirstMatchingText(document, HTTP_REQUEST_PATTERN);
  const httpMatch = httpSource?.match(HTTP_REQUEST_PATTERN);
  const hostSource = findFirstMatchingText(document, HOST_PATTERN);
  const hostMatch = hostSource?.match(HOST_PATTERN);
  const actionSource = findFirstMatchingText(document, ACTION_PATTERN);
  const actionMatch = actionSource?.match(ACTION_PATTERN);

  const inferredHost = hostMatch?.[1]?.trim();
  const inferredService = service?.trim() || inferredHost?.split('.')[0] || inferServiceFromTitle(document.title) || 'unknown-service';
  const inferredAction = actionMatch?.[1]?.trim() || inferActionFromTitle(document.title) || inferActionFromSections(document);
  const requestExample = pickJsonExample(document.codeBlocks, 'request');
  const responseExample = pickJsonExample(document.codeBlocks, 'response');
  const params = mergeParams([
    ...extractParamsFromTables(document.tables),
    ...extractParamsFromRequestExample(requestExample),
  ]);
  const examples: ExampleSpec[] = [];
  if (requestExample) {
    examples.push({ kind: 'request', content: requestExample, source: 'rule' });
  }
  if (responseExample) {
    examples.push({ kind: 'response', content: responseExample, source: 'rule' });
  }

  let draft: ExtractedActionDraft = {
    provider,
    service: inferredService,
    action: inferredAction ?? 'UnresolvedAction',
    description: inferDescription(document, inferredAction),
    method: httpMatch?.[1]?.toUpperCase() as HttpMethod | undefined,
    host: inferredHost,
    path: httpMatch?.[2],
    params,
    authHints: extractAuthHints(text),
    examples,
    confidence: 0,
    source: 'rule',
    evidence: compactEvidence([
      httpSource ? { kind: 'http', snippet: httpSource.trim() } : undefined,
      hostSource ? { kind: 'host', snippet: hostSource.trim() } : undefined,
      actionSource ? { kind: 'action', snippet: actionSource.trim() } : undefined,
    ]),
    input: {
      mode,
      sourceType: document.sourceType,
      sourceLabel: document.sourceLabel,
      contentType: document.contentType,
      importedAt: new Date().toISOString(),
    },
    status: 'draft',
  };

  const aiPatch = await maybeApplyAiPatch(mode, document, draft);
  if (aiPatch) {
    draft = mergeDraftPatch(draft, aiPatch);
  }

  draft.confidence = calculateConfidence(draft);

  const blockingMissingFields = [
    !draft.action || draft.action === 'UnresolvedAction' ? 'action' : null,
    !draft.method ? 'method' : null,
    !draft.host ? 'host' : null,
    !draft.path ? 'path' : null,
  ].filter(Boolean);

  // If the document is not a well-structured API doc (many missing fields)
  // and no AI extractor processed it, reject with a helpful message.
  if (!aiPatch && blockingMissingFields.length >= 2 && document.sourceType === 'url') {
    throw new Error(
      `该 URL 返回的内容不是格式化的 API 文档（缺少: ${blockingMissingFields.join(', ')}）。\n\n` +
      `clix 尝试用 AI 提取但未成功。请检查:\n` +
      `  1. 运行 clix init 确认已配置 LLM（provider/model/apiKey/baseUrl）\n` +
      `  2. 确认 API Key 有效且网络可达\n\n` +
      `也可以手动将接口信息整理为 Markdown 格式的本地文件，再用 --from 指定。`,
    );
  }

  if (mode === 'strict' && blockingMissingFields.length > 0) {
    throw new Error(`strict 模式导入失败，缺少关键字段：${blockingMissingFields.join(', ')}`);
  }

  return draft;
}

async function maybeApplyAiPatch(
  mode: 'strict' | 'hybrid' | 'ai',
  document: NormalizedDocument,
  draft: ExtractedActionDraft,
): Promise<Partial<ExtractedActionDraft> | null> {
  if (mode === 'strict') {
    return null;
  }

  // 1) Try custom extractor module (env var)
  const modulePath = process.env.CLIX_AI_EXTRACTOR?.trim();
  if (modulePath) {
    const importTarget = modulePath.startsWith('.') || modulePath.startsWith('/')
      ? pathToFileURL(path.resolve(modulePath)).href
      : modulePath;

    const aiModule = await import(importTarget);
    const extractor = typeof aiModule.default === 'function' ? aiModule.default : aiModule.extract;
    if (typeof extractor !== 'function') {
      throw new Error('CLIX_AI_EXTRACTOR 模块未导出 default/extract 函数。');
    }

    const patch = await extractor({ document, draft });
    return patch ?? null;
  }

  // 2) Fallback: use LLM configured via `clix init`
  return callConfiguredLlmExtractor(document, draft);
}

async function callConfiguredLlmExtractor(
  document: NormalizedDocument,
  draft: ExtractedActionDraft,
): Promise<Partial<ExtractedActionDraft> | null> {
  const { readClixConfig } = await import('./config-store');
  const config = await readClixConfig();

  const apiKey = config.llm.apiKey
    ?? (config.llm.apiKeyEnvName ? process.env[config.llm.apiKeyEnvName]?.trim() : undefined);

  if (!apiKey || !config.llm.baseUrl) {
    // No LLM configured — cannot do AI extraction
    return null;
  }

  const baseUrl = config.llm.baseUrl.replace(/\/+$/, '');
  const model = config.llm.model;

  // Truncate rawText to avoid token overflow (keep first ~8000 chars)
  const maxChars = 8000;
  const truncatedText = document.rawText.length > maxChars
    ? document.rawText.slice(0, maxChars) + '\n...(truncated)'
    : document.rawText;

  const systemPrompt = `You are an API documentation analyzer. Extract structured API information from the given document content.
Return a valid JSON object with these fields (omit any field you cannot determine):
- "action": string — the API action/operation name (e.g. "RunInstances", "CreateBucket")
- "description": string — a brief one-line description of what this API does
- "method": string — HTTP method (GET/POST/PUT/DELETE/PATCH), use "POST" if the doc says RPC-style
- "host": string — the API endpoint host (e.g. "ecs.aliyuncs.com")
- "path": string — the API path (e.g. "/", "/v2/instances"), use "/" for RPC-style APIs
- "service": string — the service/product name (e.g. "ecs", "cdb", "s3")
- "params": array of objects with { "name": string, "type": "string"|"number"|"boolean"|"array"|"object", "required": boolean, "description": string, "location": "query"|"body"|"path"|"header" }

Rules:
- For cloud provider RPC APIs (like Alibaba Cloud, Tencent Cloud), method is typically "POST" and path is "/".
- Only return the JSON object, no markdown fences, no explanation.
- Extract at most 30 most important parameters.
- Parameter descriptions should be concise (< 50 chars).`;

  const userPrompt = `Document title: ${document.title ?? '(unknown)'}
Source: ${document.sourceLabel}

Content:
${truncatedText}`;

  const { createFakeProgressBar } = await import('./tui');
  const progress = createFakeProgressBar({
    label: `正在用 AI 分析文档 (${config.llm.provider}/${model})`,
    duration: 30000,
  });

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
      const errorText = await response.text().catch(() => '');
      progress.fail(`AI 请求失败 (${response.status})`);
      console.error(`[clix] ${errorText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      progress.fail('AI 返回内容为空');
      return null;
    }

    // Strip markdown fences if present
    const jsonStr = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const patch: Partial<ExtractedActionDraft> = {
      source: 'ai',
      evidence: [{ kind: 'ai', snippet: `LLM: ${config.llm.provider}/${model}` }],
    };

    if (typeof parsed.action === 'string' && parsed.action) {
      patch.action = parsed.action;
    }
    if (typeof parsed.description === 'string' && parsed.description) {
      patch.description = parsed.description;
    }
    if (typeof parsed.method === 'string' && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(parsed.method)) {
      patch.method = parsed.method.toUpperCase() as HttpMethod;
    }
    if (typeof parsed.host === 'string' && parsed.host) {
      patch.host = parsed.host;
    }
    if (typeof parsed.path === 'string' && parsed.path) {
      patch.path = parsed.path;
    }
    if (typeof parsed.service === 'string' && parsed.service) {
      patch.service = parsed.service;
    }
    if (Array.isArray(parsed.params)) {
      patch.params = (parsed.params as Array<Record<string, unknown>>)
        .filter((p) => typeof p.name === 'string')
        .map((p) => ({
          name: String(p.name),
          type: (['string', 'number', 'boolean', 'array', 'object'].includes(String(p.type))
            ? String(p.type)
            : 'string') as ParamSpec['type'],
          required: Boolean(p.required),
          description: typeof p.description === 'string' ? p.description : undefined,
          location: (['query', 'body', 'path', 'header'].includes(String(p.location))
            ? String(p.location)
            : 'body') as ParamSpec['location'],
        }));
    }

    const actionName = patch.action ?? '未知';
    const paramCount = patch.params?.length ?? 0;
    progress.done(`提取完成 → ${actionName} (${paramCount} 个参数)`);
    return patch;
  } catch (err) {
    progress.fail(`AI 提取失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function mergeDraftPatch(
  draft: ExtractedActionDraft,
  patch: Partial<ExtractedActionDraft>,
): ExtractedActionDraft {
  return {
    ...draft,
    ...patch,
    params: mergeParams([...(draft.params ?? []), ...(patch.params ?? [])]),
    authHints: [...new Set([...(draft.authHints ?? []), ...(patch.authHints ?? [])])],
    examples: [...(draft.examples ?? []), ...(patch.examples ?? [])],
    evidence: [...(draft.evidence ?? []), ...(patch.evidence ?? [])],
    source: draft.source === 'rule' ? 'merged' : draft.source,
  };
}

function buildReview(draft: ExtractedActionDraft): ReviewResult {
  const issues: ReviewIssue[] = [];

  if (!draft.action || draft.action === 'UnresolvedAction') {
    issues.push({ code: 'ACTION_MISSING', severity: 'blocking', message: '缺少可确认的 action 名称', field: 'action' });
  }
  if (!draft.method) {
    issues.push({ code: 'METHOD_MISSING', severity: 'blocking', message: '缺少 HTTP Method', field: 'method' });
  }
  if (!draft.host) {
    issues.push({ code: 'HOST_MISSING', severity: 'blocking', message: '缺少 Host', field: 'host' });
  }
  if (!draft.path) {
    issues.push({ code: 'PATH_MISSING', severity: 'blocking', message: '缺少 Path', field: 'path' });
  }
  if (draft.params.length === 0) {
    issues.push({ code: 'PARAMS_EMPTY', severity: 'warning', message: '未识别到请求参数', field: 'params' });
  }
  if (draft.params.some((param) => param.type === 'unknown')) {
    issues.push({ code: 'PARAM_TYPE_UNKNOWN', severity: 'warning', message: '存在参数类型未识别', field: 'params' });
  }
  if (!draft.examples.some((example) => example.kind === 'request')) {
    issues.push({ code: 'REQUEST_EXAMPLE_MISSING', severity: 'warning', message: '缺少请求示例', field: 'examples' });
  }
  if (!draft.examples.some((example) => example.kind === 'response')) {
    issues.push({ code: 'RESPONSE_EXAMPLE_MISSING', severity: 'warning', message: '缺少返回示例', field: 'examples' });
  }
  if (draft.authHints.length === 0) {
    issues.push({ code: 'AUTH_HINT_MISSING', severity: 'warning', message: '未识别到鉴权提示', field: 'authHints' });
  }
  if (draft.host && draft.service !== 'unknown-service' && !draft.host.startsWith(`${draft.service}.`)) {
    issues.push({ code: 'SERVICE_HOST_CONFLICT', severity: 'warning', message: `service=${draft.service} 与 host=${draft.host} 推断不一致`, field: 'service' });
  }

  const blockingIssueCount = issues.filter((issue) => issue.severity === 'blocking').length;
  const warningCount = issues.length - blockingIssueCount;

  let status: ReviewResult['status'];
  if (draft.status === 'approved') {
    status = 'approved';
  } else if (draft.status === 'rejected') {
    status = 'rejected';
  } else {
    status = blockingIssueCount > 0 ? 'needs_attention' : 'ready';
  }

  return {
    provider: draft.provider,
    service: draft.service,
    action: draft.action,
    status,
    blockingIssueCount,
    warningCount,
    issues,
    summary:
      status === 'ready'
        ? '可进入 approve 流程。'
        : status === 'approved'
          ? '已批准，可进入后续 spec/build 流程。'
          : status === 'rejected'
            ? `已拒绝：${draft.rejectionReason ?? 'manually rejected'}`
            : `需要人工处理 ${blockingIssueCount} 个 blocking 问题。`,
    generatedAt: new Date().toISOString(),
  };
}

function resolveArtifactPaths(args: {
  workspaceRoot: string;
  outputDir: string;
  provider: string;
  service: string;
  action: string;
}): ArtifactPaths {
  const baseDir = path.join(
    path.resolve(args.workspaceRoot),
    args.outputDir,
    'imports',
    sanitizePathSegment(args.provider),
    sanitizePathSegment(args.service),
  );

  return {
    draftFilePath: path.join(baseDir, `${sanitizePathSegment(args.action)}.draft.json`),
    reviewFilePath: path.join(baseDir, `${sanitizePathSegment(args.action)}.review.json`),
  };
}

function pickJsonExample(codeBlocks: NormalizedDocument['codeBlocks'], kind: ExampleSpec['kind']): unknown | undefined {
  const parsedBlocks = codeBlocks
    .map((block) => ({ block, parsed: safeJsonParse(block.content) }))
    .filter((entry): entry is { block: NormalizedDocument['codeBlocks'][number]; parsed: Record<string, unknown> } => Boolean(entry.parsed && typeof entry.parsed === 'object'));

  if (kind === 'request') {
    return parsedBlocks.find((entry) => !('Response' in entry.parsed))?.parsed;
  }
  return parsedBlocks.find((entry) => 'Response' in entry.parsed)?.parsed;
}

function extractParamsFromRequestExample(requestExample: unknown): ParamSpec[] {
  if (!requestExample || Array.isArray(requestExample) || typeof requestExample !== 'object') {
    return [];
  }

  return Object.entries(requestExample).map(([name, value]) => ({
    name,
    type: inferValueType(value),
    required: true,
    location: 'body',
  }));
}

function extractParamsFromTables(tables: TableBlock[]): ParamSpec[] {
  const params: ParamSpec[] = [];
  for (const table of tables) {
    const header = table.header.map((cell) => cell.toLowerCase());
    const nameIndex = findHeaderIndex(header, ['参数名', '参数', 'name', 'field']);
    const typeIndex = findHeaderIndex(header, ['类型', 'type']);
    const requiredIndex = findHeaderIndex(header, ['必选', '必填', 'required']);
    const descriptionIndex = findHeaderIndex(header, ['说明', '描述', 'description']);

    if (nameIndex < 0) {
      continue;
    }

    for (const row of table.rows) {
      const name = row[nameIndex]?.trim();
      if (!name || /^-+$/.test(name)) {
        continue;
      }
      const type = normalizeParamType(row[typeIndex]);
      const required = normalizeRequiredFlag(row[requiredIndex]);
      params.push({
        name,
        type,
        required,
        description: row[descriptionIndex]?.trim() || undefined,
        location: 'body',
      });
    }
  }
  return params;
}

function findHeaderIndex(header: string[], candidates: string[]): number {
  return header.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function normalizeParamType(value?: string): ParamSpec['type'] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'unknown';
  }
  if (['string', 'str'].includes(normalized)) {
    return 'string';
  }
  if (['number', 'int', 'integer', 'float', 'double'].includes(normalized)) {
    return 'number';
  }
  if (['boolean', 'bool'].includes(normalized)) {
    return 'boolean';
  }
  if (['array', 'list'].includes(normalized)) {
    return 'array';
  }
  if (['object', 'map'].includes(normalized)) {
    return 'object';
  }
  return 'unknown';
}

function normalizeRequiredFlag(value?: string): boolean {
  const normalized = value?.trim().toLowerCase();
  return ['是', 'true', 'yes', 'y', 'required', '必填', '必选'].includes(normalized ?? '');
}

function inferDescription(document: NormalizedDocument, action?: string): string | undefined {
  if (document.title && action && document.title.includes(action)) {
    const section = document.sections.find((item) => item.heading?.includes(action));
    return section?.content.split('\n').find(Boolean)?.trim() ?? document.title;
  }
  return document.sections.find((item) => item.content.trim())?.content.split('\n').find(Boolean)?.trim();
}

function extractAuthHints(rawText: string): string[] {
  const hints = new Set<string>();
  if (/公共请求参数/.test(rawText)) {
    hints.add('包含公共请求参数');
  }
  if (/Authorization/i.test(rawText)) {
    hints.add('文档中出现 Authorization 头');
  }
  if (/SecretId|SecretKey|Token/i.test(rawText)) {
    hints.add('文档中出现密钥或 Token 关键词');
  }
  if (/X-TC-Action/i.test(rawText)) {
    hints.add('疑似 TencentCloud Action 风格接口');
  }
  return [...hints];
}

function findFirstMatchingText(document: NormalizedDocument, pattern: RegExp): string | undefined {
  for (const block of document.codeBlocks) {
    if (pattern.test(block.content)) {
      pattern.lastIndex = 0;
      return block.content;
    }
    pattern.lastIndex = 0;
  }

  if (pattern.test(document.rawText)) {
    pattern.lastIndex = 0;
    return document.rawText;
  }
  pattern.lastIndex = 0;

  return undefined;
}

function inferServiceFromTitle(title?: string): string | undefined {
  if (!title) {
    return undefined;
  }
  const lower = title.toLowerCase();
  if (lower.includes('cdb')) {
    return 'cdb';
  }
  return undefined;
}

function inferActionFromTitle(title?: string): string | undefined {
  if (!title) {
    return undefined;
  }
  const candidate = title.match(/([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+)/)?.[1];
  return candidate?.trim();
}

function inferActionFromSections(document: NormalizedDocument): string | undefined {
  for (const section of document.sections) {
    const fromHeading = section.heading?.match(/([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+)/)?.[1];
    if (fromHeading) {
      return fromHeading;
    }
  }
  return undefined;
}

function compactEvidence<T>(items: Array<T | undefined>): T[] {
  return items.filter(Boolean) as T[];
}

function calculateConfidence(draft: ExtractedActionDraft): number {
  let score = 0.15;
  if (draft.action && draft.action !== 'UnresolvedAction') {
    score += 0.2;
  }
  if (draft.method) {
    score += 0.15;
  }
  if (draft.host) {
    score += 0.15;
  }
  if (draft.path) {
    score += 0.1;
  }
  if (draft.params.length > 0) {
    score += 0.1;
  }
  if (draft.examples.some((example) => example.kind === 'request')) {
    score += 0.1;
  }
  if (draft.examples.some((example) => example.kind === 'response')) {
    score += 0.1;
  }
  if (draft.authHints.length > 0) {
    score += 0.05;
  }
  return Number(Math.min(score, 0.99).toFixed(2));
}

function toCanonicalSpec(draft: ExtractedActionDraft): CanonicalSpec {
  return {
    provider: {
      name: draft.provider,
      version: '0.1.0',
    },
    services: [
      {
        name: draft.service,
        host: draft.host,
        actions: [
          {
            name: draft.action,
            method: draft.method,
            path: draft.path,
            description: draft.description,
            params: draft.params,
            examples: draft.examples,
          },
        ],
      },
    ],
    auth: [
      {
        type: 'unstructured-hints',
        hints: draft.authHints,
      },
    ],
    sourceMeta: {
      mode: draft.input.mode,
      sourceType: draft.input.sourceType,
      sourceLabel: draft.input.sourceLabel,
      contentType: draft.input.contentType,
      importedAt: draft.input.importedAt,
      approvedAt: draft.approvedAt,
      confidence: draft.confidence,
      evidence: draft.evidence,
    },
  };
}
