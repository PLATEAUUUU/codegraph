/**
 * Git diff parsing for requirement change sets: the changed files between two
 * commits, and each file's hunks (line ranges + raw text) for later per-symbol
 * slicing. Pure git; no codegraph dependency.
 */

import { runGit } from './git';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

/** One diff hunk: its @@ line ranges and full text. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  text: string;
}

/** A file's change between two commits. */
export interface FileDiff {
  status: ChangeStatus;
  path: string;         // new path (old path when deleted)
  oldPath?: string;     // set only on rename
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse all hunks from a single file's `git diff` output. */
export function parseHunks(diffText: string): Hunk[] {
  const lines = diffText.split('\n');
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  const buf: string[] = [];

  const flush = () => {
    if (current) {
      current.text = buf.join('\n');
      hunks.push(current);
      buf.length = 0;
    }
  };

  for (const line of lines) {
    const m = HUNK_HEADER.exec(line);
    if (m) {
      flush();
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        text: '',
      };
      buf.push(line);
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return hunks;
}

/** A changed file's status and path(s), before hunks are read. */
interface NameStatusEntry {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
}

/**
 * Parse `git diff --name-status -M` output. Rename rows (`R<score>\told\tnew`)
 * become status 'R' with both paths; every other row is A/M/D with one path.
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const code = cols[0]![0]!; // R100 -> R, M -> M
    if (code === 'R') {
      entries.push({ status: 'R', path: cols[2]!, oldPath: cols[1]! });
    } else if (code === 'A' || code === 'D' || code === 'M') {
      entries.push({ status: code, path: cols[1]! });
    }
  }
  return entries;
}

/**
 * Changed files between `base` and `final` in `repo`, each with its hunks.
 * Returns [] if the name-status query fails.
 */
export function parseDiff(repo: string, base: string, final: string): FileDiff[] {
  const nameStatus = runGit(repo, ['diff', '--name-status', '-M', `${base}..${final}`]);
  if (nameStatus === null) return [];

  const files: FileDiff[] = [];
  for (const entry of parseNameStatus(nameStatus)) {
    // Diff the specific path(s); for a rename pass both so git emits the hunks.
    const args = entry.status === 'R'
      ? ['diff', `${base}..${final}`, '--', entry.oldPath!, entry.path]
      : ['diff', `${base}..${final}`, '--', entry.path];
    const diffText = runGit(repo, args) ?? '';
    files.push({
      status: entry.status,
      path: entry.path,
      oldPath: entry.oldPath,
      hunks: parseHunks(diffText),
    });
  }
  return files;
}
