import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { loadAllGrammars } from '../src/extraction';
import {
  hunkChangedLines,
  classifyFileChange,
  classifyServiceChanges,
  type SymbolSpan,
} from '../src/requirement/classify';
import type { FileDiff, Hunk } from '../src/requirement/diff';

function hunk(partial: Partial<Hunk> & { text: string }): Hunk {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, ...partial };
}

function sym(qualifiedName: string, startLine: number, endLine: number, kind = 'function'): SymbolSpan {
  return { qualifiedName, kind, signature: null, startLine, endLine };
}

describe('hunkChangedLines', () => {
  it('records changed lines per side, skipping context', () => {
    const h = hunk({
      oldStart: 10,
      newStart: 10,
      text: ['@@ -10,3 +10,4 @@', ' keep', '-old', '+new1', '+new2', ' keep'].join('\n'),
    });
    const { oldLines, newLines } = hunkChangedLines(h);
    expect(oldLines).toEqual([11]);        // the single '-' line
    expect(newLines).toEqual([11, 12]);    // the two '+' lines
  });
});

describe('classifyFileChange', () => {
  // A hunk whose new side changes line 11, old side changes line 11.
  const modifyHunk = hunk({
    oldStart: 10, newStart: 10,
    text: ['@@ -10,3 +10,3 @@', ' keep', '-old', '+new', ' keep'].join('\n'),
  });

  it('marks a symbol present on both sides as modify', () => {
    const rows = classifyFileChange({
      service: 'svc',
      fileDiff: { status: 'M', path: 'f.js', hunks: [modifyHunk] },
      baseSymbols: [sym('A::f', 8, 14)],
      finalSymbols: [sym('A::f', 8, 14)],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qualifiedName: 'A::f', changeType: 'modify', service: 'svc', filePath: 'f.js' });
    expect(rows[0].gitDiff).toContain('+new');
  });

  it('marks a pure insertion into an existing function as modify, not add', () => {
    // Only new-side changed lines (an insertion); the function exists on both sides.
    const insertHunk = hunk({
      oldStart: 5, newStart: 5,
      text: ['@@ -5,2 +5,4 @@', ' keep', '+added1', '+added2', ' keep'].join('\n'),
    });
    const rows = classifyFileChange({
      service: 'svc',
      fileDiff: { status: 'M', path: 'f.js', hunks: [insertHunk] },
      baseSymbols: [sym('f', 1, 10)],
      finalSymbols: [sym('f', 1, 12)],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qualifiedName: 'f', changeType: 'modify' });
  });

  it('marks a final-only symbol as add', () => {
    const addHunk = hunk({
      oldStart: 1, newStart: 20,
      text: ['@@ -1,0 +20,2 @@', '+function g() {}', '+// body'].join('\n'),
    });
    const rows = classifyFileChange({
      service: 'svc',
      fileDiff: { status: 'M', path: 'f.js', hunks: [addHunk] },
      baseSymbols: [],
      finalSymbols: [sym('g', 20, 21)],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qualifiedName: 'g', changeType: 'add' });
  });

  it('marks a base-only symbol as delete', () => {
    const delHunk = hunk({
      oldStart: 20, newStart: 1,
      text: ['@@ -20,2 +1,0 @@', '-function gone() {}', '-// body'].join('\n'),
    });
    const rows = classifyFileChange({
      service: 'svc',
      fileDiff: { status: 'M', path: 'f.js', hunks: [delHunk] },
      baseSymbols: [sym('gone', 20, 21)],
      finalSymbols: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qualifiedName: 'gone', changeType: 'delete' });
  });

  it('carries oldFilePath on a rename', () => {
    const rows = classifyFileChange({
      service: 'svc',
      fileDiff: { status: 'R', path: 'new.js', oldPath: 'old.js', hunks: [modifyHunk] },
      baseSymbols: [sym('A::f', 8, 14)],
      finalSymbols: [sym('A::f', 8, 14)],
    });
    expect(rows[0]).toMatchObject({ qualifiedName: 'A::f', oldFilePath: 'old.js', filePath: 'new.js' });
  });

  it('ignores symbols no changed line touches', () => {
    const rows = classifyFileChange({
      service: 'svc',
      fileDiff: { status: 'M', path: 'f.js', hunks: [modifyHunk] },  // touches line 11
      baseSymbols: [sym('A::f', 8, 14), sym('A::far', 100, 120)],
      finalSymbols: [sym('A::f', 8, 14), sym('A::far', 100, 120)],
    });
    expect(rows.map((r) => r.qualifiedName)).toEqual(['A::f']);
  });
});

describe('classifyFileChange — hierarchical merge', () => {
  // Change on line 11, inside a method inside a class.
  const h = hunk({
    oldStart: 10, newStart: 10,
    text: ['@@ -10,3 +10,3 @@', ' keep', '-old', '+new', ' keep'].join('\n'),
  });

  it('merges a local variable up into its enclosing method', () => {
    const syms = [
      sym('C', 1, 30, 'class'),
      sym('C::m', 8, 20, 'method'),
      sym('C::m::v', 11, 11, 'variable'), // local var on the changed line
    ];
    const rows = classifyFileChange({
      service: 'svc', fileDiff: { status: 'M', path: 'f.js', hunks: [h] },
      baseSymbols: syms, finalSymbols: syms,
    });
    expect(rows.map((r) => r.qualifiedName)).toEqual(['C::m']); // not the var, not the class
  });

  it('keeps a top-level variable that has no absorbing ancestor', () => {
    const syms = [
      sym('M', 1, 50, 'module'),       // module does not absorb
      sym('topVar', 11, 11, 'variable'),
    ];
    const rows = classifyFileChange({
      service: 'svc', fileDiff: { status: 'M', path: 'f.js', hunks: [h] },
      baseSymbols: syms, finalSymbols: syms,
    });
    expect(rows.map((r) => r.qualifiedName)).toEqual(['topVar']);
  });

  it('merges a class field up into the class', () => {
    const syms = [
      sym('C', 1, 30, 'class'),
      sym('C::field', 11, 11, 'field'), // field directly in class, no method
    ];
    const rows = classifyFileChange({
      service: 'svc', fileDiff: { status: 'M', path: 'f.js', hunks: [h] },
      baseSymbols: syms, finalSymbols: syms,
    });
    expect(rows.map((r) => r.qualifiedName)).toEqual(['C']);
  });

  it('attributes a class change to the class, never the namespace', () => {
    const syms = [
      sym('N', 1, 100, 'namespace'),
      sym('N::C', 5, 30, 'class'),
      sym('N::C::field', 11, 11, 'field'),
    ];
    const rows = classifyFileChange({
      service: 'svc', fileDiff: { status: 'M', path: 'f.js', hunks: [h] },
      baseSymbols: syms, finalSymbols: syms,
    });
    expect(rows.map((r) => r.qualifiedName)).toEqual(['N::C']); // not N
  });
});

// Real merged branch for requirement 1103259 (search-service).
describe('classifyServiceChanges (real)', () => {
  beforeAll(async () => { await loadAllGrammars(); });

  it.runIf(fs.existsSync('D:\\code\\search-service'))('classifies the real change', async () => {
    const { parseDiff } = await import('../src/requirement/diff');
    const repo = 'D:\\code\\search-service';
    const base = 'fbea22a2a0a8bca48a567721d5dc577861c19718';
    const final = 'ff068ce16d33c2472d591952b7bbd2f955d62c23';
    const rows = classifyServiceChanges('search-service', repo, base, final, parseDiff(repo, base, final));
    console.log('classified change nodes:', rows.map((r) => ({
      kind: r.kind, qualifiedName: r.qualifiedName, changeType: r.changeType,
    })));
    console.log('first node gitDiff:\n', rows[0]?.gitDiff);
    expect(rows.length).toBeGreaterThan(0);
  });
});
