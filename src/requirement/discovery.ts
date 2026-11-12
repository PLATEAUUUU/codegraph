/**
 * Requirement discovery: find which service repos touched a requirement and the
 * commit range of each, by scanning sibling git repos for a branch named after
 * the requirement id.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './git';

/** One service repo's participation in a requirement. */
export interface DiscoveredService {
  repo: string;         // absolute repo path
  service: string;      // repo directory name
  branch: string;       // the branch whose name contains the requirement id
  baseBranch: string | null;  // trunk used for merge-base; null if none found
  baseCommit: string | null;  // merge-base(branch, baseBranch); null if no trunk
  finalCommit: string;  // branch tip
}

export const DEFAULT_BASE_BRANCHES = ['main', 'master'];

/** Direct child directories of `root` that are git repos. */
export function scanServiceRepos(root: string): string[] {
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

/** First branch in `candidates` that exists in `repo`, or null. */
export function pickBaseBranch(repo: string, candidates = DEFAULT_BASE_BRANCHES): string | null {
  for (const branch of candidates) {
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

/** Result of a discovery run: the services found plus any warnings raised. */
export interface DiscoveryResult {
  services: DiscoveredService[];
  warnings: string[];
}

/**
 * Scan `root`'s child repos for a branch named after `reqId` and compute each
 * service's commit range.
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

    const finalCommit = runGit(repo, ['rev-parse', branch]);
    if (!finalCommit) {
      warnings.push(`${path.basename(repo)}: could not resolve tip of ${branch}`);
      continue;
    }

    const baseBranch = pickBaseBranch(repo, baseBranches);
    const baseCommit = baseBranch ? runGit(repo, ['merge-base', branch, baseBranch]) : null;
    if (!baseBranch) {
      warnings.push(`${path.basename(repo)}: no base branch (${baseBranches.join(', ')}) found; base commit unset`);
    }

    services.push({
      repo,
      service: path.basename(repo),
      branch,
      baseBranch,
      baseCommit,
      finalCommit,
    });
  }

  return { services, warnings };
}
