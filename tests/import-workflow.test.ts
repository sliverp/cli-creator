import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { approveImport, importDocument, listImports, rejectImport } from '../src/import-workflow';
import type { CanonicalSpec } from '../src/types';

describe('unstructured import workflow', () => {
  it('imports markdown into draft and review artifacts', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'clix-import-'));
    const fixturePath = path.resolve(__dirname, '../fixtures/sample-api.md');

    const result = await importDocument({
      source: fixturePath,
      provider: 'tencentcloud',
      service: 'cdb',
      mode: 'ai',
      workspaceRoot,
    });

    expect(result.draft.action).toBe('StartCpuExpand');
    expect(result.draft.method).toBe('POST');
    expect(result.draft.host).toBe('cdb.tencentcloudapi.com');
    expect(result.draft.path).toBe('/');
    expect(result.draft.params.map((item) => item.name)).toEqual(['ExpandCpu', 'InstanceId', 'Type']);
    expect(result.review.blockingIssueCount).toBe(0);
  });

  it('approves imported draft into canonical spec', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'clix-approve-'));
    const fixturePath = path.resolve(__dirname, '../fixtures/sample-api.md');

    await importDocument({
      source: fixturePath,
      provider: 'tencentcloud',
      service: 'cdb',
      mode: 'ai',
      workspaceRoot,
    });

    const approved = await approveImport({
      provider: 'tencentcloud',
      service: 'cdb',
      action: 'StartCpuExpand',
      workspaceRoot,
    });

    const spec = JSON.parse(await readFile(approved.specFilePath, 'utf8')) as CanonicalSpec;
    expect(spec.services[0]?.actions[0]?.name).toBe('StartCpuExpand');
    expect(spec.services[0]?.host).toBe('cdb.tencentcloudapi.com');
    expect(approved.review.status).toBe('approved');
  });

  it('lists and rejects imported drafts', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'clix-list-'));
    const fixturePath = path.resolve(__dirname, '../fixtures/sample-api.md');

    await importDocument({
      source: fixturePath,
      provider: 'tencentcloud',
      service: 'cdb',
      mode: 'ai',
      workspaceRoot,
    });

    const beforeReject = await listImports({ workspaceRoot, status: 'draft' });
    expect(beforeReject).toHaveLength(1);

    await rejectImport({
      provider: 'tencentcloud',
      service: 'cdb',
      action: 'StartCpuExpand',
      workspaceRoot,
      reason: 'needs manual cleanup',
    });

    const rejected = await listImports({ workspaceRoot, status: 'rejected' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reviewStatus).toBe('rejected');
  });
});
