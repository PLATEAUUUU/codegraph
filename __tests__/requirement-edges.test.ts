import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildServiceEdges, checkIndexFreshness } from '../src/requirement/edges';
import type { ChangeNodeInput } from '../src/db/requirement-store';

const tmps: string[] = [];

afterEach(() => {
  for (const d of tmps.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best-effort */ }
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function cn(filePath: string, qualifiedName: string): ChangeNodeInput {
  return { requirementId: 0, changeSetId: 0, service: 'svc', filePath, qualifiedName, changeType: 'modify' };
}

/** A git repo + indexed codegraph with two functions where a() calls b(). */
async function makeIndexedRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'req-edges-'));
  tmps.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'm.js'), 'function b() { return 1 }\nfunction a() { return b() }\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  const cg = await CodeGraph.init(repo, { index: true });
  cg.close();
  return repo;
}

describe('buildServiceEdges', () => {
  it('builds a calls edge between two changed functions', async () => {
    const repo = await makeIndexedRepo();
    const changeNodes = [cn('m.js', 'a'), cn('m.js', 'b')];  // index 0 = a, 1 = b
    const edges = buildServiceEdges(repo, changeNodes);
    const calls = edges.find((e) => e.relationType === 'calls');
    expect(calls).toBeDefined();
    expect(calls!.sourceIndex).toBe(0); // a
    expect(calls!.targetIndex).toBe(1); // b
  });

  it('drops edges whose other end is not in the change set', async () => {
    const repo = await makeIndexedRepo();
    const changeNodes = [cn('m.js', 'a')]; // only a; a->b has b outside the set
    const edges = buildServiceEdges(repo, changeNodes);
    expect(edges.every((e) => e.sourceIndex === 0 && e.targetIndex === 0)).toBe(true);
  });

  it('applies baseIndexOffset to returned indices', async () => {
    const repo = await makeIndexedRepo();
    const edges = buildServiceEdges(repo, [cn('m.js', 'a'), cn('m.js', 'b')], 10);
    const calls = edges.find((e) => e.relationType === 'calls');
    expect(calls).toMatchObject({ sourceIndex: 10, targetIndex: 11 });
  });
});

describe('checkIndexFreshness', () => {
  it('passes when the index is built at/after the final commit', async () => {
    const repo = await makeIndexedRepo();
    const final = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(checkIndexFreshness(repo, final).ok).toBe(true);
  });

  it('fails when a newer commit postdates the index', async () => {
    const repo = await makeIndexedRepo();
    await new Promise((r) => setTimeout(r, 1100)); // ensure a strictly later commit second
    fs.writeFileSync(path.join(repo, 'm.js'), 'function b() { return 2 }\nfunction a() { return b() }\n');
    git(repo, ['commit', '-q', '-am', 'later']);
    const newer = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const res = checkIndexFreshness(repo, newer);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('older than');
  });

  it('fails when the repo has no index', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'req-edges-noidx-'));
    tmps.push(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.t']);
    git(repo, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'x.js'), 'const z = 1\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const final = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(checkIndexFreshness(repo, final).ok).toBe(false);
  });
});
