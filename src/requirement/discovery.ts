/**
 * Requirement discovery: scan sibling git repos for a branch named after the
 * requirement id, and resolve each branch's own commits.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './git';

/**
 * How a branch's own commits were found:
 * - unmerged: `branch --not trunk`
 * - merged:   union of every round the branch was merged into trunk
 * - fallback: merge-base range, else the branch's first-parent run; may include
 *             commits from other branches
 */
export type CommitMode = 'unmerged' | 'merged' | 'fallback';

/** One service repo's participation in a requirement. */
export interface DiscoveredService {
  repo: string;               // absolute repo path
  service: string;            // repo directory name
  branch: string;             // the branch whose name contains the requirement id
  baseBranch: string | null;  // trunk the branch is compared against; null if none found
  baseCommit: string | null;  // parent of the oldest commit; null if that commit is a root
  finalCommit: string;        // newest commit of the requirement
  mode: CommitMode;
  commits: string[];          // the requirement's own commits, oldest first
}

export const DEFAULT_BASE_BRANCHES = ['main', 'master'];

/** Cap on the fallback first-parent walk. */
const FALLBACK_WALK_LIMIT = 100;

/** `[root]` when `root` is itself a git repo, else its direct child git repos. */
export function scanServiceRepos(root: string): string[] {
  if (fs.existsSync(path.join(root, '.git'))) return [root];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const repo = path.join(root, e.name);
    if (fs.existsSync(path.join(repo, '.git'))) repos.push(repo);
  }
  return repos;
}

/**
 * Trunk ref for the first name in `candidates` that exists in `repo`:
 * `origin/<name>` if present, else the local `<name>`. null if none exist.
 */
export function pickBaseBranch(repo: string, candidates = DEFAULT_BASE_BRANCHES): string | null {
  for (const branch of candidates) {
    if (runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]) !== null) {
      return `origin/${branch}`;
    }
    if (runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null) {
      return branch;
    }
  }
  return null;
}

/**
 * Local branch in `repo` whose name contains `reqId`. On multiple matches,
 * returns the first and pushes a message onto `warnings`.
 */
export function findRequirementBranch(repo: string, reqId: string, warnings: string[]): string | null {
  const out = runGit(repo, ['branch', '--list', '--format=%(refname:short)']);
  if (out === null || out === '') return null;
  const matches = out.split('\n').map((b) => b.trim()).filter((b) => b.includes(reqId));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    warnings.push(`${path.basename(repo)}: multiple branches match "${reqId}" (${matches.join(', ')}); using ${matches[0]}`);
  }
  return matches[0]!;
}

/** `git rev-list` output as a list; [] on failure or no output. */
function revList(repo: string, args: string[]): string[] {
  const out = runGit(repo, ['rev-list', ...args]);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Commits the branch brought into trunk across every merge round. A round is a
 * merge on trunk's first-parent line whose second parent lies on the branch's
 * own first-parent line; its commits are `M^2 --not M^1`. Oldest first.
 */
function mergedRounds(repo: string, branch: string, trunk: string): string[] {
  const branchLine = new Set(revList(repo, ['--first-parent', branch]));
  const merges = runGit(repo, ['log', '--first-parent', '--merges', '--reverse', '--format=%H %P', trunk]);
  if (!merges) return [];

  const commits: string[] = [];
  const seen = new Set<string>();
  for (const line of merges.split('\n')) {
    const [m, p1, p2] = line.trim().split(' ');
    if (!m || !p1 || !p2 || !branchLine.has(p2)) continue;
    for (const c of revList(repo, ['--no-merges', '--reverse', p2, '--not', p1])) {
      if (!seen.has(c)) { seen.add(c); commits.push(c); }
    }
  }
  return commits;
}

/** The branch's first-parent run back to the first merge commit, oldest first. */
function firstParentRun(repo: string, branch: string): string[] {
  const out = runGit(repo, ['rev-list', '--first-parent', '--parents', `--max-count=${FALLBACK_WALK_LIMIT}`, branch]);
  if (!out) return [];
  const run: string[] = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length > 2) break; // merge commit
    run.push(parts[0]!);
  }
  return run.reverse();
}

/**
 * The requirement's own commits on `branch`, oldest first. Tries, in order:
 * `branch --not trunk`, the merged-rounds union, the merge-base range, then the
 * branch's first-parent run.
 */
export function resolveCommits(
  repo: string,
  branch: string,
  trunk: string | null,
): { mode: CommitMode; commits: string[] } {
  if (trunk) {
    const unmerged = revList(repo, ['--no-merges', '--reverse', branch, '--not', trunk]);
    if (unmerged.length > 0) return { mode: 'unmerged', commits: unmerged };

    const merged = mergedRounds(repo, branch, trunk);
    if (merged.length > 0) return { mode: 'merged', commits: merged };

    const base = runGit(repo, ['merge-base', branch, trunk]);
    if (base) {
      const range = revList(repo, ['--no-merges', '--reverse', `${base}..${branch}`]);
      if (range.length > 0) return { mode: 'fallback', commits: range };
    }
  }
  return { mode: 'fallback', commits: firstParentRun(repo, branch) };
}

/** Assemble a DiscoveredService for `branch` in `repo`, or null if it can't be resolved. */
function buildService(
  repo: string,
  branch: string,
  baseBranches: string[],
  warnings: string[],
): DiscoveredService | null {
  const name = path.basename(repo);
  if (!runGit(repo, ['rev-parse', '--verify', '--quiet', branch])) {
    warnings.push(`${name}: could not resolve ${branch}`);
    return null;
  }
  const baseBranch = pickBaseBranch(repo, baseBranches);
  if (!baseBranch) warnings.push(`${name}: no base branch (${baseBranches.join(', ')}) found`);

  const { mode, commits } = resolveCommits(repo, branch, baseBranch);
  if (mode === 'fallback') warnings.push(`${name}: own commits not separable from trunk; using fallback range`);

  const oldest = commits[0];
  const newest = commits[commits.length - 1];
  return {
    repo,
    service: name,
    branch,
    baseBranch,
    baseCommit: oldest ? runGit(repo, ['rev-parse', '--verify', '--quiet', `${oldest}^`]) : null,
    finalCommit: newest ?? (runGit(repo, ['rev-parse', branch]) as string),
    mode,
    commits,
  };
}

/** Result of a discovery run: the services found plus any warnings raised. */
export interface DiscoveryResult {
  services: DiscoveredService[];
  warnings: string[];
}

/**
 * Resolve an explicitly named service + branch into a DiscoveredService.
 * null if the repo or branch is missing.
 */
export function resolveService(
  root: string,
  service: string,
  branch: string,
  baseBranches = DEFAULT_BASE_BRANCHES,
): DiscoveredService | null {
  const repo = path.join(root, service);
  if (!fs.existsSync(path.join(repo, '.git'))) return null;
  return buildService(repo, branch, baseBranches, []);
}

/**
 * Resolve a comma-separated service spec against `discovered`: `name` picks a
 * discovered service, `name:branch` resolves one discovery missed.
 */
export function resolveServicesSpec(
  spec: string,
  discovered: DiscoveredService[],
  root: string,
  baseBranches = DEFAULT_BASE_BRANCHES,
): { services: DiscoveredService[] } | { error: string } {
  const services: DiscoveredService[] = [];
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    if (sep >= 0) {
      const name = entry.slice(0, sep);
      const branch = entry.slice(sep + 1);
      const resolved = resolveService(root, name, branch, baseBranches);
      if (!resolved) return { error: `Cannot resolve service "${name}" branch "${branch}" under ${root}` };
      services.push(resolved);
    } else {
      const found = discovered.find((s) => s.service === entry);
      if (!found) return { error: `Service "${entry}" was not discovered; pass "${entry}:<branch>" to supplement it` };
      services.push(found);
    }
  }
  return { services };
}

/**
 * Scan `root`'s child repos for a branch named after `reqId` and resolve each
 * service's commits.
 */
export function discoverRequirementChanges(
  root: string,
  reqId: string,
  baseBranches = DEFAULT_BASE_BRANCHES,
): DiscoveryResult {
  const warnings: string[] = [];
  const services: DiscoveredService[] = [];

  const repos = scanServiceRepos(root);
  if (repos.length === 0) warnings.push(`No git repositories found under ${root}`);

  for (const repo of repos) {
    const branch = findRequirementBranch(repo, reqId, warnings);
    if (!branch) continue;
    const svc = buildService(repo, branch, baseBranches, warnings);
    if (svc) services.push(svc);
  }

  return { services, warnings };
}
