import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseHunks, parseNameStatus, parseDiff } from '../src/requirement/diff';

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

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'req-diff-'));
  tmps.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  return repo;
}

function commitAll(repo: string, msg: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
}

describe('parseHunks', () => {
  it('parses line ranges and keeps hunk text', () => {
    const diff = [
      'diff --git a/f.txt b/f.txt',
      'index 111..222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -10,3 +10,4 @@ context',
      ' keep',
      '-old',
      '+new1',
      '+new2',
      ' keep',
      '@@ -50 +51,2 @@',
      '-gone',
      '+added',
      '+added2',
    ].join('\n');

    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 });
    expect(hunks[0].text).toContain('+new1');
    expect(hunks[0].text).toContain('@@ -10,3 +10,4 @@');
    // single-line form "@@ -50 +51,2 @@" => oldLines defaults to 1
    expect(hunks[1]).toMatchObject({ oldStart: 50, oldLines: 1, newStart: 51, newLines: 2 });
  });

  it('returns [] when there are no hunks', () => {
    expect(parseHunks('diff --git a/x b/x\nsimilarity index 100%\n')).toEqual([]);
  });
});

describe('parseNameStatus', () => {
  it('parses A/M/D and rename rows', () => {
    const out = [
      'M\tsrc/a.ts',
      'A\tsrc/b.ts',
      'D\tsrc/c.ts',
      'R100\tsrc/old.ts\tsrc/new.ts',
    ].join('\n');
    const entries = parseNameStatus(out);
    expect(entries).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/b.ts' },
      { status: 'D', path: 'src/c.ts' },
      { status: 'R', path: 'src/new.ts', oldPath: 'src/old.ts' },
    ]);
  });
});

describe('parseDiff', () => {
  it('reports add / modify / delete with hunks', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\ny\n');
    const base = commitAll(repo, 'base');

    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nB\nc\n');   // modify
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');      // add
    fs.rmSync(path.join(repo, 'gone.txt'));                       // delete
    const final = commitAll(repo, 'work');

    const diffs = parseDiff(repo, base, final);
    const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));
    expect(byPath['keep.txt'].status).toBe('M');
    expect(byPath['keep.txt'].hunks.length).toBeGreaterThan(0);
    expect(byPath['new.txt'].status).toBe('A');
    expect(byPath['gone.txt'].status).toBe('D');
  });

  it('detects a file rename', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'old.txt'), 'line1\nline2\nline3\nline4\n');
    const base = commitAll(repo, 'base');

    fs.rmSync(path.join(repo, 'old.txt'));
    fs.writeFileSync(path.join(repo, 'new.txt'), 'line1\nline2\nline3\nline4\n');
    const final = commitAll(repo, 'rename');

    const diffs = parseDiff(repo, base, final);
    const rename = diffs.find((d) => d.status === 'R');
    expect(rename).toBeDefined();
    expect(rename!.oldPath).toBe('old.txt');
    expect(rename!.path).toBe('new.txt');
  });

  // Real merged branch for requirement 1103259 (search-service).
  it.runIf(fs.existsSync('D:\\code\\search-service'))('parses a real diff', () => {
    const base = 'fbea22a2a0a8bca48a567721d5dc577861c19718';
    const final = 'ff068ce16d33c2472d591952b7bbd2f955d62c23';
    const diffs = parseDiff('D:\\code\\search-service', base, final);
    console.log('real diff files:', diffs.map((d) => ({
      status: d.status, path: d.path, oldPath: d.oldPath, hunks: d.hunks.length,
    })));
    console.log('first hunk of first file:\n', diffs[0]?.hunks[0]?.text);
    expect(diffs.length).toBeGreaterThan(0);
    for (const d of diffs) {
      expect(['A', 'M', 'D', 'R']).toContain(d.status);
    }
  });
});
