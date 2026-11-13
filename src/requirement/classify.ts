/**
 * Classify diffs into changed symbols (add / modify / delete): changed lines are
 * matched against symbols extracted from the base and final version of each
 * file. Each symbol carries the diff hunks that touch it.
 */

import { extractFromSource } from '../extraction';
import { detectLanguage } from '../extraction/grammars';
import { runGit, runGitRaw } from './git';
import { parseDiff } from './diff';
import type { Node } from '../types';
import type { FileDiff, Hunk } from './diff';
import type { ChangeNodeInput } from '../db/requirement-store';

/** Fields kept from an extracted node. */
export interface SymbolSpan {
  qualifiedName: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
}

/** Extract symbols from a file at a given commit. [] if the blob is absent. */
export function extractSymbols(repo: string, commit: string, filePath: string): SymbolSpan[] {
  const source = runGitRaw(repo, ['show', `${commit}:${filePath}`]);
  if (source === null) return [];
  const language = detectLanguage(filePath, source);
  const result = extractFromSource(filePath, source, language);
  return (result.nodes as Node[])
    .filter((n) => n.kind !== 'file')
    .map((n) => ({
      qualifiedName: n.qualifiedName,
      kind: n.kind,
      signature: n.signature ?? null,
      startLine: n.startLine,
      endLine: n.endLine,
    }));
}

/** The old- and new-side line numbers a hunk actually changes (not context). */
export function hunkChangedLines(hunk: Hunk): { oldLines: number[]; newLines: number[] } {
  const oldLines: number[] = [];
  const newLines: number[] = [];
  let oldLn = hunk.oldStart;
  let newLn = hunk.newStart;
  const body = hunk.text.split('\n').slice(1); // drop the @@ header line
  for (const line of body) {
    const c = line[0];
    if (c === '+') {
      newLines.push(newLn++);
    } else if (c === '-') {
      oldLines.push(oldLn++);
    } else {
      oldLn++;
      newLn++;
    }
  }
  return { oldLines, newLines };
}

/** Does any line in `lines` fall within the symbol's [startLine, endLine]? */
function touches(sym: SymbolSpan, lines: number[]): boolean {
  return lines.some((ln) => ln >= sym.startLine && ln <= sym.endLine);
}

/** Kinds a changed line is attributed to before falling back to any containing symbol. */
const ABSORBING_KINDS = new Set([
  'function', 'method', 'class', 'struct', 'interface',
  'trait', 'protocol', 'enum', 'type_alias', 'route', 'component',
]);

const span = (s: SymbolSpan): number => s.endLine - s.startLine;

/**
 * The symbol each changed line belongs to: the innermost absorbing-kind symbol
 * containing it; if none, the innermost containing symbol of any kind. Returns
 * the set of owner symbols keyed by qualifiedName.
 */
function ownersOf(lines: number[], symbols: SymbolSpan[]): Map<string, SymbolSpan> {
  const owners = new Map<string, SymbolSpan>();
  for (const ln of lines) {
    const containing = symbols.filter((s) => ln >= s.startLine && ln <= s.endLine);
    if (containing.length === 0) continue;
    const absorbing = containing.filter((s) => ABSORBING_KINDS.has(s.kind));
    const pool = absorbing.length > 0 ? absorbing : containing;
    const owner = pool.reduce((a, b) => (span(b) < span(a) ? b : a));
    owners.set(owner.qualifiedName, owner);
  }
  return owners;
}

/** Context for classifying one file: its diff plus both versions' symbols. */
export interface ClassifyInput {
  service: string;
  fileDiff: FileDiff;
  baseSymbols: SymbolSpan[];
  finalSymbols: SymbolSpan[];
}

/**
 * Classify one file's changes into ChangeNodeInput rows (requirementId /
 * changeSetId are filled later by the writer). Set-diff on qualified name:
 * final-only = add, base-only = delete, both = modify.
 */
export function classifyFileChange(input: ClassifyInput): ChangeNodeInput[] {
  const { service, fileDiff, baseSymbols, finalSymbols } = input;

  // Aggregate changed lines and keep per-hunk sides for slicing.
  const perHunk = fileDiff.hunks.map((h) => ({ hunk: h, ...hunkChangedLines(h) }));
  const oldChanged = perHunk.flatMap((h) => h.oldLines);
  const newChanged = perHunk.flatMap((h) => h.newLines);

  // Symbols touched = owners of the changed lines; add/modify/delete = whether
  // each touched name exists in the base set, the final set, or both.
  const baseByName = new Map(baseSymbols.map((s) => [s.qualifiedName, s]));
  const finalByName = new Map(finalSymbols.map((s) => [s.qualifiedName, s]));

  const touched = new Set<string>([
    ...ownersOf(oldChanged, baseSymbols).keys(),
    ...ownersOf(newChanged, finalSymbols).keys(),
  ]);

  const filePath = fileDiff.path;
  const oldFilePath = fileDiff.status === 'R' ? fileDiff.oldPath : undefined;

  const rows: ChangeNodeInput[] = [];
  for (const name of touched) {
    const base = baseByName.get(name);
    const final = finalByName.get(name);
    const changeType = final && base ? 'modify' : final ? 'add' : 'delete';
    const sym = (final ?? base)!;
    rows.push({
      requirementId: 0,   // set by the writer
      changeSetId: 0,     // set by the writer
      service,
      filePath,
      oldFilePath,
      kind: sym.kind,
      qualifiedName: name,
      signature: sym.signature,
      changeType,
      gitDiff: sliceDiff(perHunk, base, final),
    });
  }
  return rows;
}

/** Join the hunks that touch this symbol on whichever side(s) it exists. */
function sliceDiff(
  perHunk: Array<{ hunk: Hunk; oldLines: number[]; newLines: number[] }>,
  base: SymbolSpan | undefined,
  final: SymbolSpan | undefined,
): string {
  const parts: string[] = [];
  for (const h of perHunk) {
    const hitNew = !!final && touches(final, h.newLines);
    const hitOld = !!base && touches(base, h.oldLines);
    if (hitNew || hitOld) parts.push(h.hunk.text);
  }
  return parts.join('\n');
}

/**
 * Classify every changed file of a service into ChangeNodeInput rows. Extracts
 * base/final symbols per file (rename uses oldPath for base, path for final).
 */
export function classifyServiceChanges(
  service: string,
  repo: string,
  base: string,
  final: string,
  fileDiffs: FileDiff[],
): ChangeNodeInput[] {
  const rows: ChangeNodeInput[] = [];
  for (const fileDiff of fileDiffs) {
    const basePath = fileDiff.oldPath ?? fileDiff.path;
    const baseSymbols = extractSymbols(repo, base, basePath);
    const finalSymbols = fileDiff.status === 'D' ? [] : extractSymbols(repo, final, fileDiff.path);
    rows.push(...classifyFileChange({ service, fileDiff, baseSymbols, finalSymbols }));
  }
  return rows;
}

/** git's empty tree; the base of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Combine an earlier change type with a later one on the same symbol.
 * null means the two cancel out (added then deleted).
 */
export function mergeChangeType(prev: string, next: string): string | null {
  if (prev === 'add') return next === 'delete' ? null : 'add';
  if (prev === 'delete') return next === 'add' ? 'modify' : 'delete';
  return next === 'delete' ? 'delete' : 'modify';
}

/**
 * Classify each commit against its parent, then fold the per-commit rows into
 * one row per (filePath, qualifiedName) using mergeChangeType. Diffs are joined
 * in commit order. `commits` must be oldest first.
 */
export function classifyCommits(service: string, repo: string, commits: string[]): ChangeNodeInput[] {
  const folded = new Map<string, ChangeNodeInput>();
  for (const c of commits) {
    const parent = runGit(repo, ['rev-parse', '--verify', '--quiet', `${c}^`]) ?? EMPTY_TREE;
    const rows = classifyServiceChanges(service, repo, parent, c, parseDiff(repo, parent, c));
    for (const row of rows) {
      const key = `${row.filePath}\0${row.qualifiedName}`;
      const prev = folded.get(key);
      if (!prev) { folded.set(key, row); continue; }
      const changeType = mergeChangeType(prev.changeType!, row.changeType!);
      if (changeType === null) { folded.delete(key); continue; }
      folded.set(key, {
        ...row,
        oldFilePath: prev.oldFilePath ?? row.oldFilePath,
        changeType,
        gitDiff: [prev.gitDiff, row.gitDiff].filter(Boolean).join('\n'),
      });
    }
  }
  return [...folded.values()];
}
