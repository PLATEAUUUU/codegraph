/**
 * Build change_edges by reading the already-resolved edges from each service's
 * codegraph index. A change_node is mapped to its index node via logical key
 * (qualifiedName + index-root-relative path); edges with both endpoints in the
 * change set are kept. The index must be no older than the final commit.
 */

import * as path from 'path';
import { CodeGraph } from '../index';
import { findNearestCodeGraphRoot } from '../directory';
import { normalizePath } from '../utils';
import { runGit } from './git';
import type { Node } from '../types';
import type { ChangeNodeInput } from '../db/requirement-store';

/** An edge between two change_nodes, referenced by their index in the batch. */
export interface ChangeEdgeByIndex {
  sourceIndex: number;
  targetIndex: number;
  relationType: string;
}

export interface FreshnessResult {
  ok: boolean;
  reason?: string;
}

/**
 * The index covering `serviceRepo` must have been built at or after the final
 * commit. Compares getLastIndexedAt() against the commit's timestamp.
 */
export function checkIndexFreshness(serviceRepo: string, finalCommit: string): FreshnessResult {
  const indexRoot = findNearestCodeGraphRoot(serviceRepo);
  if (!indexRoot) return { ok: false, reason: `${serviceRepo}: no codegraph index found` };

  const cg = CodeGraph.openSync(indexRoot, { readOnly: true });
  try {
    const indexedAt = cg.getLastIndexedAt();
    if (indexedAt == null) return { ok: false, reason: `${indexRoot}: index has never been built` };

    const ct = runGit(serviceRepo, ['show', '-s', '--format=%ct', finalCommit]);
    if (ct === null) return { ok: false, reason: `${serviceRepo}: cannot read commit time of ${finalCommit}` };
    const finalMs = Number(ct) * 1000;

    if (indexedAt < finalMs) {
      return { ok: false, reason: `${indexRoot}: index is older than the requirement's final commit; re-index on the requirement branch` };
    }
    return { ok: true };
  } finally {
    cg.close();
  }
}

/** Index-root-relative, forward-slash path for a change_node, layout-agnostic. */
function indexRelPath(indexRoot: string, serviceRepo: string, filePath: string): string {
  return normalizePath(path.relative(indexRoot, path.join(serviceRepo, filePath)));
}

/** The index node id a change_node maps to, or null if unmatched. */
function mapToIndexNode(cg: CodeGraph, indexRoot: string, serviceRepo: string, cn: ChangeNodeInput): string | null {
  if (!cn.qualifiedName) return null;
  const want = indexRelPath(indexRoot, serviceRepo, cn.filePath ?? '');
  const candidates = cg.getNodesByQualifiedName(cn.qualifiedName) as Node[];
  const match = candidates.find((n) => normalizePath(n.filePath) === want);
  return match ? match.id : null;
}

/**
 * Edges among `changeNodes` for one service, read from its index. Returns edges
 * whose source and target are both in the change set, referenced by batch index
 * (`baseIndexOffset` is added so indices address a multi-service batch).
 */
export function buildServiceEdges(
  serviceRepo: string,
  changeNodes: ChangeNodeInput[],
  baseIndexOffset = 0,
): ChangeEdgeByIndex[] {
  const indexRoot = findNearestCodeGraphRoot(serviceRepo);
  if (!indexRoot) return [];

  const cg = CodeGraph.openSync(indexRoot, { readOnly: true });
  try {
    // index node id -> position in the batch
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < changeNodes.length; i++) {
      const nodeId = mapToIndexNode(cg, indexRoot, serviceRepo, changeNodes[i]!);
      if (nodeId) idToIndex.set(nodeId, baseIndexOffset + i);
    }
    if (idToIndex.size === 0) return [];

    const edges: ChangeEdgeByIndex[] = [];
    const seen = new Set<string>();
    for (const edge of cg.getOutgoingEdgesFrom([...idToIndex.keys()])) {
      const sourceIndex = idToIndex.get(edge.source);
      const targetIndex = idToIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue; // both ends must be in the change set
      const key = `${sourceIndex}\0${targetIndex}\0${edge.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ sourceIndex, targetIndex, relationType: edge.kind });
    }
    return edges;
  } finally {
    cg.close();
  }
}
