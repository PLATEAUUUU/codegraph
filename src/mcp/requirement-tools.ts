/**
 * MCP tools over the requirement graph (requirement.db). These read a project's
 * .codegraph-req/ directly and never touch the code index, so ToolHandler.execute
 * short-circuits to handleRequirementTool before its code-index pipeline.
 */

import type { ToolDefinition, ToolResult } from './tools';
import type { RequirementDetail, LocationHistoryEntry, RequirementRow, RequirementStore } from '../db/requirement-store';
import type { DiscoveredService } from '../requirement/discovery';
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
  'save_requirement',
  'update_requirement',
  'del_requirement',
  'add_dict_terms',
  'remove_dict_terms',
  'list_dict_terms',
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
  {
    name: 'save_requirement',
    description:
      'Record a finished requirement: find the services whose branch name contains the requirement id under `root`, take each branch\'s own commits, and store what they changed. Call with dry_run first to check the services and commit counts found, then call again to store. Each service should be re-indexed on its requirement branch first, or its edges are refused as stale.',
    inputSchema: {
      type: 'object',
      properties: {
        requirements_id: { type: 'string', description: 'The requirement id; also the marker looked for in branch names, e.g. "1103259".' },
        title: { type: 'string', description: 'Requirement title.' },
        text: { type: 'string', description: 'Full requirement text (the PRD), stored as written.' },
        services: { type: 'string', description: 'Comma-separated services to record: "name" for a discovered one, "name:branch" to add one discovery missed. Omit to take every discovered service that has commits.' },
        feature_name: { type: 'string', description: 'Feature/module name, e.g. "product search".' },
        feature_path: { type: 'string', description: 'Where the feature sits in the product, e.g. "catalog / search / filters".' },
        api: { type: 'string', description: 'Comma-separated backend API paths this requirement reaches; empty string if it reaches none.' },
        base_branch: { type: 'string', description: 'Comma-separated trunk candidates (default: main,master).' },
        root: rootProperty,
        dry_run: { type: 'boolean', description: 'Report the services found and store nothing.' },
      },
      required: ['requirements_id', 'title', 'text', 'feature_name', 'feature_path', 'api'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'update_requirement',
    description:
      'Re-record a requirement that was already stored: find its services again, take their current commits, and replace the stored record. Use after more work landed on the requirement branches, or to correct the stored description. The replacement is atomic. Call with dry_run first to check the services found.',
    inputSchema: {
      type: 'object',
      properties: {
        requirements_id: { type: 'string', description: 'The id of the requirement to re-record.' },
        title: { type: 'string', description: 'Requirement title.' },
        text: { type: 'string', description: 'Full requirement text (the PRD), stored as written.' },
        feature_name: { type: 'string', description: 'Feature/module name.' },
        feature_path: { type: 'string', description: 'Where the feature sits in the product.' },
        api: { type: 'string', description: 'Comma-separated backend API paths this requirement reaches; empty string if it reaches none.' },
        services: { type: 'string', description: 'Comma-separated services: "name" for a discovered one, "name:branch" to add one discovery missed. Omit to take every discovered service that has commits.' },
        base_branch: { type: 'string', description: 'Comma-separated trunk candidates (default: main,master).' },
        root: rootProperty,
        dry_run: { type: 'boolean', description: 'Report the services found and store nothing.' },
      },
      required: ['requirements_id', 'title', 'text', 'feature_name', 'feature_path', 'api'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'del_requirement',
    description:
      'Delete a stored requirement and everything recorded under it: its change sets, changed symbols and their diffs. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        requirements_id: { type: 'string', description: 'The id of the requirement to delete.' },
        root: rootProperty,
      },
      required: ['requirements_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'add_dict_terms',
    description:
      'Add domain terms to the requirement search dictionary, then re-segment every stored requirement so the new terms match older records too. Use it for product terms the segmenter splits wrongly — a term broken apart cannot be searched as one word. Add only domain and product vocabulary; adding ordinary words disturbs how everything else is segmented.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'string', description: 'Comma-separated terms to add; each must contain no whitespace.' },
        freq: { type: 'number', description: 'Word frequency; omit to let the segmenter pick one that keeps the term whole.' },
        root: rootProperty,
      },
      required: ['terms'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'remove_dict_terms',
    description:
      'Remove terms from the requirement search dictionary, then re-segment every stored requirement. Terms that were not in the dictionary are reported back.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'string', description: 'Comma-separated terms to remove.' },
        root: rootProperty,
      },
      required: ['terms'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_dict_terms',
    description: 'List every term in the requirement search dictionary.',
    inputSchema: {
      type: 'object',
      properties: { root: rootProperty },
    },
    annotations: { readOnlyHint: true },
  },
];

/** Split a comma-separated argument into trimmed, non-empty entries. */
function splitList(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
}

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

function formatDiscovery(discovered: DiscoveredService[], warnings: string[]): string {
  const lines = warnings.map((w) => `warning: ${w}`);
  if (discovered.length === 0) {
    lines.push('No services found with a branch matching the requirement id.');
    return lines.join('\n');
  }
  lines.push(`${discovered.length} service(s) found:`);
  for (const s of discovered) {
    const note = s.commits.length === 0 ? '  (no commits — skipped unless listed in services)' : '';
    lines.push(`  ${s.service}  branch ${s.branch}  ${s.commits.length} commits  ${s.mode}${note}`);
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
 * Discover the requirement's services, then store its change graph. With
 * dry_run, report what was discovered and store nothing.
 */
async function recordRequirement(
  args: Record<string, unknown>,
  root: string,
  store: RequirementStore,
  text: (s: string) => ToolResult,
  mode: 'save' | 'update',
): Promise<ToolResult> {
  const { discoverRequirementChanges, resolveServicesSpec, DEFAULT_BASE_BRANCHES } = await import('../requirement/discovery');
  const reqId = String(args.requirements_id ?? '');
  const baseBranchList = splitList(args.base_branch);
  const baseBranches = baseBranchList.length > 0 ? baseBranchList : DEFAULT_BASE_BRANCHES;

  const { services: discovered, warnings } = discoverRequirementChanges(root, reqId, baseBranches);
  if (args.dry_run) return text(formatDiscovery(discovered, warnings));

  let selected: DiscoveredService[];
  if (typeof args.services === 'string' && args.services) {
    const resolved = resolveServicesSpec(args.services, discovered, root, baseBranches);
    if ('error' in resolved) return text(resolved.error);
    selected = resolved.services;
  } else {
    selected = discovered.filter((s) => s.commits.length > 0);
  }
  if (selected.length === 0) {
    return text(`No services with commits found for "${reqId}" under ${root}.\n${formatDiscovery(discovered, warnings)}`);
  }

  const existing = store.getRequirementByReqId(reqId);
  if (mode === 'save' && existing) {
    return text(`Requirement "${reqId}" is already recorded. Call update_requirement to re-record it, or del_requirement to remove it first.`);
  }
  if (mode === 'update' && !existing) {
    return text(`Requirement "${reqId}" is not recorded yet. Call save_requirement to record it.`);
  }

  const { checkIndexFreshness } = await import('../requirement/edges');
  for (const s of selected) {
    const fresh = checkIndexFreshness(s.repo, s.finalCommit);
    if (!fresh.ok) return text(`Cannot build edges: ${fresh.reason}`);
  }

  const { loadAllGrammars } = await import('../extraction');
  await loadAllGrammars();
  const { buildRequirementBundle } = await import('../requirement/add');
  const apiList = splitList(args.api);
  const requirement = {
    requirementsId: reqId,
    title: String(args.title ?? ''),
    originalText: String(args.text ?? ''),
    featureName: typeof args.feature_name === 'string' ? args.feature_name : null,
    featurePath: typeof args.feature_path === 'string' ? args.feature_path : null,
    entryPoint: apiList.length > 0 ? JSON.stringify(apiList) : null,
  };
  const { bundle, builds } = buildRequirementBundle(requirement, selected);
  const replaceId = mode === 'update' ? existing!.requirement.id : null;
  const newId = store.runInTransaction(() => {
    if (replaceId !== null) store.deleteRequirement(replaceId);
    return store.saveRequirementBundle(bundle);
  });

  const lines = [`${mode === 'update' ? 'Updated' : 'Recorded'} requirement ${reqId} (id ${newId}).`];
  for (const b of builds) lines.push(`  ${b.service}: ${b.nodeCount} symbols, ${b.edgeCount} relationships`);
  return text(lines.join('\n'));
}

/**
 * Run a requirement tool against the requirement graph under `root`. `text`
 * wraps a string into the caller's ToolResult. Expected misses (no graph,
 * requirement not found, no history) return a plain text result, not an error.
 */
export async function handleRequirementTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  text: (s: string) => ToolResult,
): Promise<ToolResult> {
  // save_requirement creates the graph on first use; the readers need it present.
  if (name !== 'save_requirement' && !requirementDirExists(root)) {
    return text(`No requirement graph under ${root}. Record a requirement with save_requirement (or "codegraph req add") first.`);
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
      case 'save_requirement':
        return await recordRequirement(args, root, store, text, 'save');
      case 'update_requirement':
        return await recordRequirement(args, root, store, text, 'update');
      case 'del_requirement': {
        const id = String(args.requirements_id ?? '');
        const detail = store.getRequirementByReqId(id);
        if (!detail) return text(`Requirement "${id}" not found; nothing deleted.`);
        const { changeSets, changeNodes, changeEdges } = detail;
        store.deleteRequirement(detail.requirement.id);
        return text(
          `Deleted requirement ${id} "${detail.requirement.title ?? '(untitled)'}": ` +
          `${changeSets.length} change set(s), ${changeNodes.length} symbol(s), ${changeEdges.length} relationship(s).`
        );
      }
      case 'add_dict_terms': {
        const terms = splitList(args.terms);
        if (terms.length === 0) return text('No terms given.');
        const bad = terms.filter((t) => /\s/.test(t));
        if (bad.length > 0) return text(`These terms contain whitespace and cannot be added: ${bad.join(', ')}`);
        const freq = typeof args.freq === 'number' ? args.freq : null;
        store.addDictTerms(terms.map((term) => ({ term, freq })));
        return text(`Added ${terms.length} term(s): ${terms.join(', ')}. Stored requirements were re-segmented.`);
      }
      case 'remove_dict_terms': {
        const terms = splitList(args.terms);
        if (terms.length === 0) return text('No terms given.');
        const removed = store.removeDictTerms(terms);
        const missing = terms.filter((t) => !removed.includes(t));
        const lines: string[] = [];
        if (removed.length > 0) lines.push(`Removed ${removed.length} term(s): ${removed.join(', ')}. Stored requirements were re-segmented.`);
        if (missing.length > 0) lines.push(`Not in the dictionary: ${missing.join(', ')}`);
        return text(lines.join('\n'));
      }
      case 'list_dict_terms': {
        const terms = store.listDictTerms();
        if (terms.length === 0) return text('The dictionary is empty.');
        return text(terms.map((t) => (t.freq !== null ? `${t.term} (freq ${t.freq})` : t.term)).join('\n'));
      }
      default:
        return text(`Unknown requirement tool: ${name}`);
    }
  } finally {
    close();
  }
}
