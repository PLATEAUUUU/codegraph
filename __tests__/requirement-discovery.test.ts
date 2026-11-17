import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanServiceRepos,
  pickBaseBranch,
  findRequirementBranch,
  discoverRequirementChanges,
} from '../src/requirement/discovery';

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

/** A git repo with one commit on `trunk`, then a branch off it. */
function makeRepo(parent: string, name: string, trunk: string, featureBranch?: string): string {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', trunk]);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  if (featureBranch) {
    git(repo, ['checkout', '-q', '-b', featureBranch]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nworld\n');
    git(repo, ['commit', '-q', '-am', 'feature work']);
  }
  return repo;
}

describe('scanServiceRepos', () => {
  it('returns only direct child dirs that are git repos', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    makeRepo(root, 'svc-a', 'main');
    makeRepo(root, 'svc-b', 'master');
    fs.mkdirSync(path.join(root, 'not-a-repo'));

    const repos = scanServiceRepos(root).map((r) => path.basename(r)).sort();
    expect(repos).toEqual(['svc-a', 'svc-b']);
  });

  it('returns [root] when root is itself a git repo, ignoring nested repos', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(parent);
    const root = makeRepo(parent, 'mono', 'main');
    makeRepo(root, 'vendored', 'main'); // nested repo, must be ignored

    expect(scanServiceRepos(root)).toEqual([root]);
  });

  it('returns empty for a missing root', () => {
    expect(scanServiceRepos(path.join(os.tmpdir(), 'does-not-exist-xyz'))).toEqual([]);
  });
});

describe('pickBaseBranch', () => {
  it('prefers earlier candidates (main over master)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const repo = makeRepo(root, 'svc', 'main');
    git(repo, ['branch', 'master']); // both exist
    expect(pickBaseBranch(repo, ['main', 'master'])).toBe('main');
  });

  it('falls through to master when main is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const repo = makeRepo(root, 'svc', 'master');
    expect(pickBaseBranch(repo, ['main', 'master'])).toBe('master');
  });

  it('returns null when no candidate exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const repo = makeRepo(root, 'svc', 'trunk');
    expect(pickBaseBranch(repo, ['main', 'master'])).toBeNull();
  });
});

describe('findRequirementBranch', () => {
  it('matches a branch whose name contains the id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const repo = makeRepo(root, 'svc', 'main', 'feature/1103259');
    const warnings: string[] = [];
    expect(findRequirementBranch(repo, '1103259', warnings)).toBe('feature/1103259');
    expect(warnings).toHaveLength(0);
  });

  it('returns null and no warning when nothing matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const repo = makeRepo(root, 'svc', 'main', 'feature/other');
    const warnings: string[] = [];
    expect(findRequirementBranch(repo, '1103259', warnings)).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it('takes the first of multiple matches and warns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const repo = makeRepo(root, 'svc', 'main', 'feature/1103259');
    git(repo, ['branch', 'hotfix/1103259']);
    const warnings: string[] = [];
    const branch = findRequirementBranch(repo, '1103259', warnings);
    expect(branch).toContain('1103259');
    expect(warnings).toHaveLength(1);
  });
});

describe('discoverRequirementChanges', () => {
  it('finds participating services with their commit range', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    makeRepo(root, 'svc-a', 'main', 'feature/1103259');
    makeRepo(root, 'svc-b', 'master', 'feature/1103259');
    makeRepo(root, 'svc-c', 'main'); // not involved

    const { services, warnings } = discoverRequirementChanges(root, '1103259');
    const names = services.map((s) => s.service).sort();
    expect(names).toEqual(['svc-a', 'svc-b']);
    for (const s of services) {
      expect(s.branch).toBe('feature/1103259');
      expect(s.finalCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.baseCommit).not.toBe(s.finalCommit);
      expect(s.mode).toBe('unmerged');
      expect(s.commits).toEqual([s.finalCommit]);
    }
    expect(warnings).toHaveLength(0);
  });

  it('falls back to the first-parent run when no trunk is found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    makeRepo(root, 'svc', 'develop', 'feature/1103259');

    const { services, warnings } = discoverRequirementChanges(root, '1103259');
    expect(services).toHaveLength(1);
    expect(services[0].baseBranch).toBeNull();
    expect(services[0].mode).toBe('fallback');
    expect(services[0].commits).toHaveLength(2); // init + feature work, no merge to stop at
    expect(services[0].baseCommit).toBeNull();   // oldest commit is the root
    expect(warnings.some((w) => w.includes('no base branch'))).toBe(true);
  });

  it('warns when the root has no repositories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-disc-'));
    tmps.push(root);
    const { services, warnings } = discoverRequirementChanges(root, '1103259');
    expect(services).toEqual([]);
    expect(warnings.some((w) => w.includes('No git repositories'))).toBe(true);
  });

  it.runIf(fs.existsSync('D:\\code'))('discovers services under D:\\code for 1103259', () => {
    const { services, warnings } = discoverRequirementChanges('D:\\code', '1103259');
    console.log('discovered services:', JSON.stringify(services, null, 2));
    console.log('warnings:', warnings);
    expect(Array.isArray(services)).toBe(true);
  });
});
