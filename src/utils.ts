import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ParamSpec, ParamType } from './types';

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sanitizePathSegment(value: string | undefined): string {
  const normalized = (value ?? '').trim() || 'unknown';
  return normalized.replace(/[\\/?%*:|"<>]/g, '-').replace(/\s+/g, '-');
}

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function inferValueType(value: unknown): ParamType {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (value && typeof value === 'object') {
    return 'object';
  }
  return 'unknown';
}

export function mergeParams(params: ParamSpec[]): ParamSpec[] {
  const byName = new Map<string, ParamSpec>();

  for (const param of params) {
    const current = byName.get(param.name);
    if (!current) {
      byName.set(param.name, { ...param });
      continue;
    }

    byName.set(param.name, {
      ...current,
      ...param,
      description: param.description ?? current.description,
      enum: param.enum?.length ? param.enum : current.enum,
      type: current.type === 'unknown' ? param.type : current.type,
      required: current.required || param.required,
    });
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function collectFiles(
  dirPath: string,
  matcher: (filePath: string) => boolean,
  acc: string[] = [],
): Promise<string[]> {
  if (!(await fileExists(dirPath))) {
    return acc;
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, matcher, acc);
      continue;
    }
    if (matcher(fullPath)) {
      acc.push(fullPath);
    }
  }

  return acc;
}

export function safeJsonParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
