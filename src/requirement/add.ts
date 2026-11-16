/**
 * Build a requirement's change bundle from a confirmed set of services: classify
 * each service's own commits, build edges among the changed symbols, and
 * assemble a RequirementBundle for RequirementStore.saveRequirementBundle.
 * Callers must load grammars (loadAllGrammars) first.
 */

import { classifyCommits } from './classify';
import { buildServiceEdges } from './edges';
import { runGit } from './git';
import type { DiscoveredService } from './discovery';
import type { RequirementBundle, BundleService, RequirementInput, CommitInfo } from '../db/requirement-store';

/** {sha, message} for each commit, oldest first. */
function commitInfos(repo: string, shas: string[]): CommitInfo[] {
  return shas.map((sha) => ({
    sha,
    message: runGit(repo, ['show', '-s', '--format=%s', sha]) ?? '',
  }));
}

/** Per-service outcome, for reporting what was built. */
export interface ServiceBuild {
  service: string;
  nodeCount: number;
  edgeCount: number;
}

export interface BuiltBundle {
  bundle: RequirementBundle;
  builds: ServiceBuild[];
}

/**
 * Build the bundle for `requirement` across `services`. Services with no
 * commits are skipped. Grammars must already be loaded.
 */
export function buildRequirementBundle(
  requirement: RequirementInput,
  services: DiscoveredService[],
): BuiltBundle {
  const bundleServices: BundleService[] = [];
  const builds: ServiceBuild[] = [];

  for (const svc of services) {
    if (svc.commits.length === 0) continue;
    const changeNodes = classifyCommits(svc.service, svc.repo, svc.commits);
    const edges = buildServiceEdges(svc.repo, changeNodes);

    bundleServices.push({
      changeSet: {
        requirementId: 0, // set by the writer
        repo: svc.repo,
        service: svc.service,
        branchName: svc.branch,
        baseCommit: svc.baseCommit,
        finalCommit: svc.finalCommit,
        commits: commitInfos(svc.repo, svc.commits),
      },
      changeNodes,
      edges,
    });
    builds.push({ service: svc.service, nodeCount: changeNodes.length, edgeCount: edges.length });
  }

  return { bundle: { requirement, services: bundleServices }, builds };
}
