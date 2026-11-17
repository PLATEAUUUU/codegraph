/**
 * MCP tools over the requirement graph (requirement.db). These read a project's
 * .codegraph-req/ directly and never touch the code index, so ToolHandler.execute
 * short-circuits to handleRequirementTool before its code-index pipeline.
 */

import type { ToolDefinition, ToolResult } from './tools';
import type { RequirementDetail, LocationHistoryEntry, RequirementRow } from '../db/requirement-store';
import { openRequirementStore } from '../db/requirement-db';
import { requirementDirExists } from '../directory';

const rootProperty = {
  type: 'string',
  description: 'Directory holding the requirement graph (.codegraph-req/). Defaults to the server project root.',
};

export const REQUIREMENT_TOOL_NAMES = new Set([
  'search_requirements',
  'get_requirement_changes',
  'get_location_history',
]);

export const requirementTools: ToolDefinition[] = [
  {
    name: 'search_requirements',
    description:
      "Find past requirements most similar to the given text (a new requirement's PRD or a summary of it). Returns whole requirements, most similar first. Call at the start of a new requirement to find prior work to reuse.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "The new requirement's text or key points to match against stored requirements." },
        limit: { type: 'number', description: 'Max results (default: 3)', default: 3 },
        root: rootProperty,
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_requirement_changes',
    description:
      "Get a past requirement's full change record: each service's change set, its commits, and the symbols changed with their relationships. Call after search_requirements to see exactly what a similar requirement changed.",
    inputSchema: {
      type: 'object',
      properties: {
        requirements_id: { type: 'string', description: 'The requirement id as stored, e.g. "1103259".' },
        root: rootProperty,
      },
      required: ['requirements_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_location_history',
    description:
      'List every past change to one code location, newest first, each with its requirement, commits and diff. Call before editing a symbol to see how it was changed before.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service/microservice name the symbol belongs to.' },
        qualified_name: { type: 'string', description: 'Fully-qualified symbol name.' },
        root: rootProperty,
      },
      required: ['service', 'qualified_name'],
    },
    annotations: { readOnlyHint: true },
  },
];

function clip(text: string | null, n: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + ' …' : t;
}

function formatRequirementBrief(r: RequirementRow): string {
  const lines = [
    `${r.requirementsId ?? r.id}  ${r.title ?? '(untitled)'}`,
    `  Feature: ${r.featureName ?? '-'}  (${r.featurePath ?? '-'})`,
  ];
  const text = clip(r.originalText, 300);
  if (text) lines.push(`  ${text}`);
  return lines.join('\n');
}

function formatRequirementDetail(detail: RequirementDetail): string {
  const r = detail.requirement;
  const lines = [`${r.requirementsId ?? r.id}  ${r.title ?? '(untitled)'}`, `Feature: ${r.featureName ?? '-'}  (${r.featurePath ?? '-'})`];

  const nodeById = new Map(detail.changeNodes.map((n) => [n.id, n]));
  const nodeLabel = (n: typeof detail.changeNodes[number]) => `[${n.changeType ?? '?'}] ${n.qualifiedName ?? n.filePath ?? '?'}`;

  for (const cs of detail.changeSets) {
    lines.push(`\n● ${cs.service ?? cs.repo ?? '?'}  (${cs.branchName ?? '-'})`);
    for (const c of cs.commits) lines.push(`  ${c.sha.slice(0, 7)} ${c.message}`);

    const nodes = detail.changeNodes.filter((n) => n.changeSetId === cs.id);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = detail.changeEdges.filter((e) => nodeIds.has(e.sourceChangeNodeId) && nodeIds.has(e.targetChangeNodeId));
    const linked = new Set<number>();
    for (const e of edges) {
      const s = nodeById.get(e.sourceChangeNodeId);
      const t = nodeById.get(e.targetChangeNodeId);
      if (!s || !t) continue;
      linked.add(s.id); linked.add(t.id);
      lines.push(`  ${nodeLabel(s)}  ─${e.relationType ?? 'related'}→  ${nodeLabel(t)}`);
    }
    for (const n of nodes) if (!linked.has(n.id)) lines.push(`  ${nodeLabel(n)}`);
  }
  return lines.join('\n');
}

function formatLocationHistory(service: string, qualifiedName: string, history: LocationHistoryEntry[]): string {
  const lines = [`${service} :: ${qualifiedName}  (${history.length} changes)`];
  for (const h of history) {
    lines.push(`\n● ${h.requirementsId ?? '-'}  ${h.title ?? '(untitled)'}  [${h.changeType ?? '?'}]`);
    for (const c of h.commits) lines.push(`  ${c.sha.slice(0, 7)} ${c.message}`);
    const diff = (h.gitDiff ?? '').trim();
    if (diff) lines.push(diff.split('\n').map((l) => '  ' + l).join('\n'));
  }
  return lines.join('\n');
}

/**
 * Run a requirement tool against the requirement graph under `root`. `text`
 * wraps a string into the caller's ToolResult. Expected misses (no graph,
 * requirement not found, no history) return a plain text result, not an error.
 */
export function handleRequirementTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  text: (s: string) => ToolResult,
): ToolResult {
  if (!requirementDirExists(root)) {
    return text(`No requirement graph under ${root}. Record requirements with "codegraph req add" first.`);
  }
  const { store, close } = openRequirementStore(root);
  try {
    switch (name) {
      case 'search_requirements': {
        const limit = typeof args.limit === 'number' ? args.limit : 3;
        const hits = store.searchRequirements(String(args.text ?? ''), limit);
        if (hits.length === 0) return text('No similar requirements found.');
        return text(hits.map(formatRequirementBrief).join('\n\n'));
      }
      case 'get_requirement_changes': {
        const id = String(args.requirements_id ?? '');
        const detail = store.getRequirementByReqId(id);
        if (!detail) return text(`Requirement "${id}" not found.`);
        return text(formatRequirementDetail(detail));
      }
      case 'get_location_history': {
        const service = String(args.service ?? '');
        const qn = String(args.qualified_name ?? '');
        const history = store.getLocationHistory(service, qn);
        if (history.length === 0) {
          let cands = store.findLocations(qn, service);
          if (cands.length === 0) cands = store.findLocations(qn);
          const hint = cands.length ? '\nDid you mean:\n' + cands.map((c) => `  --service ${c.service ?? '-'}  "${c.qualifiedName}"`).join('\n') : '';
          return text(`No history for ${service} :: ${qn}.${hint}`);
        }
        return text(formatLocationHistory(service, qn, history));
      }
      default:
        return text(`Unknown requirement tool: ${name}`);
    }
  } finally {
    close();
  }
}
