import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickBaseBranch, resolveCommits } from '../src/requirement/discovery';
import { mergeChangeType } from '../src/requirement/classify';

const tmps: string[] = [];

afterEach(() => {
  for (const d of tmps.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best-effort */ }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
}

/** A repo with one commit on main. */
function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'req-commits-'));
  tmps.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  commitOn(repo, 'main', 'base.txt');
  return repo;
}

/** Check out `branch`, write `file`, commit; return the new sha. */
function commitOn(repo: string, branch: string, file: string): string {
  // The branch may be unborn right after `git init -b` — already on it then.
  try { git(repo, ['checkout', '-q', branch]); } catch { /* unborn branch */ }
  fs.writeFileSync(path.join(repo, file), `${file} ${Date.now()} ${Math.random()}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', file]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** Merge `from` into `into` with a real merge commit. */
function mergeNoFf(repo: string, into: string, from: string): void {
  git(repo, ['checkout', '-q', into]);
  git(repo, ['merge', '-q', '--no-ff', '-m', `merge ${from} into ${into}`, from]);
}

describe('resolveCommits — unmerged', () => {
  it('returns only the branch commits for a clean branch', () => {
    const repo = initRepo();
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    commitOn(repo, 'main', 'other.txt'); // someone else's work on main

    expect(resolveCommits(repo, 'feat', 'main')).toEqual({ mode: 'unmerged', commits: [e] });
  });

  it('excludes trunk commits merged into the branch (case 2)', () => {
    const repo = initRepo();
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    commitOn(repo, 'main', 'other.txt');
    mergeNoFf(repo, 'feat', 'main');     // feat pulls main in
    const g = commitOn(repo, 'feat', 'g.txt');

    expect(resolveCommits(repo, 'feat', 'main')).toEqual({ mode: 'unmerged', commits: [e, g] });
  });
});

describe('resolveCommits — stale local trunk', () => {
  it('compares against origin/<trunk> when the local trunk is behind', () => {
    const repo = initRepo();
    const base = git(repo, ['rev-parse', 'main']);
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    const x = commitOn(repo, 'main', 'other.txt');   // someone else's work, now on origin
    git(repo, ['update-ref', 'refs/remotes/origin/main', x]);
    git(repo, ['checkout', '-q', 'feat']);
    git(repo, ['branch', '-f', 'main', base]);       // local main never pulled
    git(repo, ['merge', '-q', '--no-ff', '-m', 'pull origin main', x]);

    const trunk = pickBaseBranch(repo, ['main', 'master']);
    expect(trunk).toBe('origin/main');
    expect(resolveCommits(repo, 'feat', trunk)).toEqual({ mode: 'unmerged', commits: [e] });
  });
});

describe('resolveCommits — merged back', () => {
  it('recovers a clean branch merged into trunk (case 1)', () => {
    const repo = initRepo();
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    const f = commitOn(repo, 'feat', 'f.txt');
    commitOn(repo, 'main', 'other.txt');
    mergeNoFf(repo, 'main', 'feat');

    expect(resolveCommits(repo, 'feat', 'main')).toEqual({ mode: 'merged', commits: [e, f] });
  });

  it('unions every round when merged back more than once', () => {
    const repo = initRepo();
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    mergeNoFf(repo, 'main', 'feat');     // round 1
    commitOn(repo, 'main', 'other.txt');
    const g = commitOn(repo, 'feat', 'g.txt');
    mergeNoFf(repo, 'main', 'feat');     // round 2

    expect(resolveCommits(repo, 'feat', 'main')).toEqual({ mode: 'merged', commits: [e, g] });
  });

  it('excludes trunk commits when the branch pulled trunk in, then merged back (case 3)', () => {
    const repo = initRepo();
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    commitOn(repo, 'main', 'other.txt');
    mergeNoFf(repo, 'feat', 'main');     // feat pulls main in
    const g = commitOn(repo, 'feat', 'g.txt');
    mergeNoFf(repo, 'main', 'feat');     // and merges back

    expect(resolveCommits(repo, 'feat', 'main')).toEqual({ mode: 'merged', commits: [e, g] });
  });
});

describe('resolveCommits — fallback', () => {
  it('is never empty after a fast-forward merge back', () => {
    const repo = initRepo();
    git(repo, ['branch', 'feat']);
    const e = commitOn(repo, 'feat', 'e.txt');
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '-q', '--ff-only', 'feat']); // no merge commit

    const { mode, commits } = resolveCommits(repo, 'feat', 'main');
    expect(mode).toBe('fallback');
    expect(commits).toContain(e); // may also hold trunk commits; never empty
  });
});

describe('mergeChangeType', () => {
  it.each([
    ['add', 'modify', 'add'],
    ['add', 'delete', null],
    ['modify', 'modify', 'modify'],
    ['modify', 'delete', 'delete'],
    ['delete', 'add', 'modify'],
  ])('%s then %s → %s', (prev, next, want) => {
    expect(mergeChangeType(prev, next)).toBe(want);
  });
});
