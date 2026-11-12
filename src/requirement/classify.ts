/**
 * Classify a file's diff into changed symbols (add / modify / delete) by
 * intersecting changed lines with symbols extracted from the base and final
 * versions of each file. Each symbol carries the diff hunks that touch it.
 */

import { extractFromSource } from '../extraction';
import { detectLanguage } from '../extraction/grammars';
import { runGitRaw } from './git';
import type { Node } from '../types';
import type { FileDiff, Hunk } from './diff';
import type { ChangeNodeInput } from '../db/requirement-store';

/** Symbol fields S4 needs from an extracted node. */
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

  // Full-set lookups decide existence (add/modify/delete); changed lines only
  // decide which symbols this diff touches. A pure insertion into an existing
  // function has no old-side changed line, yet the function exists on both
  // sides and must read as modify, not add.
  const baseByName = new Map(baseSymbols.map((s) => [s.qualifiedName, s]));
  const finalByName = new Map(finalSymbols.map((s) => [s.qualifiedName, s]));

  const touched = new Set<string>();
  for (const s of baseSymbols) if (touches(s, oldChanged)) touched.add(s.qualifiedName);
  for (const s of finalSymbols) if (touches(s, newChanged)) touched.add(s.qualifiedName);

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
